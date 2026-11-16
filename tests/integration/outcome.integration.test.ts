/**
 * agbossjs/agboss#1017 on the real server: an error after the send reads as of unknown outcome,
 * and the effect really is in Redis when the answer is the thing that was lost. A TCP proxy
 * (`LinkProxy`, the shape of the core's `DatabaseProxy`) sits between the store's connection and the server: it forwards the
 * `EVALSHA`, lets the server apply it, and cuts the link before the answer comes back; or freezes
 * the link so the bytes never reach the server, and cuts it. What the offline queue does with a
 * command issued while the link is down is recorded too (it waits, it is not refused). The server's
 * own refusals are real ones: `WRONGTYPE` mid-script after a write that stays, `NOPERM` of an ACL
 * user before the script runs.
 */
import { randomUUID } from "node:crypto";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { ClientClosedError, ClientOfflineError, createClient, ErrorReply } from "@redis/client";
import { ExecutionRecordStatus, StoreClock, StoreTimeSource } from "@agboss/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisExecutionLeaseRepository,
  RedisRateLimitRepository,
} from "../../src/index.js";
import { RedisScript, runScript } from "../../src/connection/scripts.js";
import { ACQUIRE } from "../../src/stores/leases/lease-scripts.js";
import { DEPTH, SAVE } from "../../src/stores/queue/queue-scripts.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { TestApplicationContext } from "../support/application-context.js";
import { SharedKeptIds } from "../support/redis-store.js";
import { LinkProxy } from "../support/link-proxy.js";
import { DURABLE_URL } from "../support/server.js";

const PREFIX = `agboss-test:outcome:${randomUUID()}:`;
const SET = new RedisScript("redis.call('SET', KEYS[1], ARGV[1]) return 1");
const SET_THEN_WRONGTYPE = new RedisScript(
  "redis.call('SET', KEYS[1], ARGV[1]) return redis.call('GET', KEYS[2])",
);

/** The next turn of the event loop twice: what the client queued is written to its socket. */
const written = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#1017: a Redis write of unknown outcome",
  () => {
    const server = new URL(DURABLE_URL.length === 0 ? "redis://127.0.0.1:6379" : DURABLE_URL);
    let proxy: LinkProxy;
    const direct = createClient({ url: DURABLE_URL });
    direct.on("error", () => undefined);
    const opened: RedisConnection[] = [];

    /** A connection through the proxy, started. */
    const throughProxy = async (): Promise<RedisConnection> => {
      const url = new URL(DURABLE_URL);
      url.hostname = "127.0.0.1";
      url.port = String(proxy.port);
      const connection = new RedisConnection({ url: url.toString(), keyPrefix: PREFIX });
      await connection.onInit();
      opened.push(connection);
      return connection;
    };

    beforeEach(async () => {
      proxy = await LinkProxy.start({
        host: server.hostname,
        port: Number(server.port === "" ? "6379" : server.port),
      });
    });

    afterEach(async () => {
      for (const connection of opened.splice(0)) await connection.onDestroy();
      await proxy.close();
    });

    beforeAll(async () => {
      await direct.connect();
      await direct.scriptLoad(SET.source);
      await direct.scriptLoad(SET_THEN_WRONGTYPE.source);
      for (const script of [ACQUIRE, SAVE, DEPTH]) await direct.scriptLoad(script.source);
    });

    afterAll(async () => {
      for await (const keys of direct.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 500 }))
        if (keys.length > 0) await direct.unlink(keys);
      await direct.close();
    });

    const key = (name: string): string => `${PREFIX}${name}`;

    it("the EVALSHA is forwarded and applied, its answer is lost: unknown, and the effect IS in Redis", async () => {
      const connection = await throughProxy();
      proxy.dropAfter(/EVALSHA/u);

      const error = await runScript(connection.client, SET, [key("applied")], ["1"]).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(error).toMatchObject({
        code: "store.outcome-unknown",
        source: StoreOutcomeSource.Transport,
        store: "RedisConnection",
      });
      expect(error).toHaveProperty("cause");
      expect(await direct.get(key("applied"))).toBe("1");
    });

    it("a store's call: the lease IS taken in Redis, the call fails as unknown, not as a failure", async () => {
      const connection = await throughProxy();
      const clock = new StoreClock(StoreTimeSource.Database, { now: () => new Date() });
      const leases = new RedisExecutionLeaseRepository(
        connection,
        clock,
        new TestApplicationContext({}, "instance-lost-answer"),
        new SharedKeptIds(),
      );
      proxy.dropAfter(/EVALSHA/u);

      const error = await leases
        .acquire("default", "lost-answer-1", seconds(30))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(await direct.exists(`${PREFIX}lease:["default","lost-answer-1"]`)).toBe(1);
    });

    it("the link cut before the EVALSHA bytes reach the server: unknown all the same, and nothing applied", async () => {
      const connection = await throughProxy();
      proxy.freeze();
      const call = runScript(connection.client, SET, [key("never-arrived")], ["1"]).catch(
        (caught: unknown) => caught,
      );
      await written();
      proxy.drop();

      // the client cannot tell this from a lost answer: the wrongly unknown costs one takeover
      expect(await call).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(await direct.exists(key("never-arrived"))).toBe(0);
      proxy.reconnect();
    });

    it("a command issued while the link is down waits in the offline queue, and runs once it is back", async () => {
      const connection = await throughProxy();
      proxy.drop();
      await vi.waitFor(
        () => {
          expect(connection.client.isReady).toBe(false);
        },
        { timeout: 10_000 },
      );

      const call = runScript(connection.client, SET, [key("queued")], ["1"]);
      const settled = vi.fn();
      void call.then(settled, settled);
      await written();
      expect(settled).not.toHaveBeenCalled();
      expect(await direct.exists(key("queued"))).toBe(0);

      proxy.reconnect();
      expect(await call).toBe(1);
      expect(await direct.get(key("queued"))).toBe("1");
    });

    it("a command on a closed client never left: ClientClosedError, known", async () => {
      const connection = await throughProxy();
      await connection.onDestroy();

      const error = await runScript(connection.client, SET, [key("closed")], ["1"]).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ClientClosedError);
      expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
    });

    it("a command on an offline client without an offline queue never left: ClientOfflineError, known", async () => {
      const client = createClient({
        url: `redis://127.0.0.1:${String(proxy.port)}`,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: () => 50 },
      });
      client.on("error", () => undefined);
      await client.connect();
      try {
        proxy.drop();
        await vi.waitFor(
          () => {
            expect(client.isReady).toBe(false);
          },
          { timeout: 10_000 },
        );

        const error = await runScript(client, SET, [key("offline")], ["1"]).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(ClientOfflineError);
        expect(await direct.exists(key("offline"))).toBe(0);
      } finally {
        proxy.reconnect();
        client.destroy();
      }
    });

    it("the server's error in the middle of a script (WRONGTYPE after a SET that stays): unknown, the SET IS there", async () => {
      const connection = await throughProxy();
      await direct.rPush(key("a-list"), "x");

      const error = await runScript(
        connection.client,
        SET_THEN_WRONGTYPE,
        [key("before-the-error"), key("a-list")],
        ["1"],
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StoreOutcomeUnknownError);
      expect(error).toHaveProperty("cause.message", expect.stringContaining("WRONGTYPE"));
      expect(error).toHaveProperty("cause.message", expect.stringContaining("@user_script"));
      expect(await direct.get(key("before-the-error"))).toBe("1");
    });

    it("the server refuses before the script runs (NOPERM of an ACL user): known, its own ErrorReply", async () => {
      const user = `outcome-${randomUUID()}`;
      await direct.aclSetUser(user, ["on", ">pw", "+ping", "~*"]);
      const base = new URL(DURABLE_URL);
      const client = createClient({
        url: `redis://${user}:pw@${base.hostname}:${base.port === "" ? "6379" : base.port}`,
      });
      client.on("error", () => undefined);
      await client.connect();
      try {
        const error = await runScript(client, SET, [key("denied")], ["1"]).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(ErrorReply);
        expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
        expect(error).toHaveProperty("message", expect.stringMatching(/^NOPERM /u));
        expect(await direct.exists(key("denied"))).toBe(0);
      } finally {
        await client.close();
        await direct.aclDelUser(user);
      }
    });

    it("a read script keeps the driver's own error when the link is lost", async () => {
      const connection = await throughProxy();
      const read = new RedisScript("return redis.call('GET', KEYS[1])", true);
      await direct.scriptLoad(read.source);
      proxy.dropAfter(/EVALSHA/u);

      const error = await runScript(connection.client, read, [key("a-read")], []).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(StoreOutcomeUnknownError);
    });

    const clock = { now: () => new Date(), sleep: () => Promise.resolve(), monotonicNow: () => 0 };

    it("the rate limits' direct writes (ZREM of a release, DEL of a cleared window): unknown, and applied", async () => {
      const connection = await throughProxy();
      const limits = new RedisRateLimitRepository(
        connection,
        clock,
        new TestApplicationContext({}, "instance-limits"),
      );
      const slot = await limits.acquire("outcome-slots", 1, seconds(30));
      if (slot === undefined) throw new Error("a free slot is taken");
      await limits.addToWindow("outcome-window", 2, seconds(60));
      const slotsKey = `${PREFIX}rate-limit-slots:["outcome-slots"]`;
      const windowKey = `${PREFIX}rate-limit-window:["outcome-window"]`;

      proxy.dropAfter(/ZREM/u);
      const released = await limits.release(slot).catch((caught: unknown) => caught);
      proxy.dropAfter(/DEL/u);
      const cleared = await limits.clearWindow("outcome-window").catch((caught: unknown) => caught);

      expect(released).toMatchObject({ code: "store.outcome-unknown", operation: "ZREM" });
      expect(cleared).toMatchObject({ code: "store.outcome-unknown", operation: "DEL" });
      expect(await direct.zCard(slotsKey)).toBe(0);
      expect(await direct.exists(windowKey)).toBe(0);
    });

    it("the child queue's save: unknown, and the child IS queued; its depth, a read, keeps the driver's error", async () => {
      const connection = await throughProxy();
      const queue = new RedisChildExecutionQueueRepository(
        connection,
        clock,
        new TestApplicationContext({}, "instance-queue"),
        new RecordingLogger(),
      );
      proxy.dropAfter(/EVALSHA/u);
      const saved = await queue
        .saveIfAbsent({
          ...{ tenantId: "default", executionId: "outcome-child", depth: 1, run: "{}" },
          ...{ rootExecutionId: "outcome-root", parentExecutionId: "outcome-root" },
          ...{ rootWorkflow: "root", workflow: "child", queuedAt: new Date() },
          status: ExecutionRecordStatus.Queued,
        })
        .catch((caught: unknown) => caught);
      proxy.dropAfter(/EVALSHA/u);
      const depth = await queue.countByStatus().catch((caught: unknown) => caught);

      expect(saved).toMatchObject({ code: "store.outcome-unknown", store: "RedisConnection" });
      expect(await direct.exists(`${PREFIX}child:["default","outcome-child"]`)).toBe(1);
      expect(depth).toBeInstanceOf(Error);
      expect(depth).not.toBeInstanceOf(StoreOutcomeUnknownError);
    });
  },
);
