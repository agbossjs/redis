/**
 * agbossjs/agboss#789: the child queue's subscription notices a connection that dies silently —
 * through a TCP proxy that drops every byte with no FIN and no RST (`socket.destroy()` would be a
 * FIN, and node-redis would reconnect on its own). The instance warns within
 * `redisWatchLivenessSeconds` (a `PING` every half, an answer due in the other half, on the
 * clock), subscribes on a new connection after the first pause, wakes once (the catch-up), then
 * hears the next save. A subscription the network swallows gives up within the bound and is retried.
 */
import { ExecutionRecordStatus, LogLevel, type QueuedChildExecution } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { RedisChildExecutionQueueRepository, RedisConnection } from "../../src/index.js";
import { BlackholeProxy } from "../support/blackhole-proxy.js";
import { TestApplicationContext } from "../support/application-context.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionOf, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const LIVENESS_SECONDS = 10;
/** How long a new connection may take in real time (a loaded machine): a hang bound, not an assertion. */
const CONNECTS = { timeout: 15_000 };
const cleanups: (() => Promise<void>)[] = [];

const child = (executionId: string): QueuedChildExecution => ({
  ...{ tenantId: "default", executionId, rootExecutionId: "root-1", parentExecutionId: "root-1" },
  ...{ rootWorkflow: "root-workflow", workflow: "child-workflow", depth: 2, run: "{}" },
  ...{ status: ExecutionRecordStatus.Queued, queuedAt: new Date(0) },
});

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#789: the Redis child queue's subscription on a silently dead connection",
  () => {
    const space = testKeySpace("queue-watch-silent-death");

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    afterAll(async () => {
      await space.close();
    });

    /** An instance whose subscriber reaches the server through a proxy, and one that saves directly. */
    async function instances() {
      const server = new URL(DURABLE_URL);
      const proxy = await BlackholeProxy.start({
        host: server.hostname,
        port: Number(server.port),
      });
      cleanups.push(() => proxy.close());
      const through = new URL(DURABLE_URL);
      through.hostname = "127.0.0.1";
      through.port = String(proxy.port);
      const connection = new RedisConnection({
        url: through.toString(),
        keyPrefix: space.prefix,
        watchLivenessSeconds: LIVENESS_SECONDS,
      });
      const clock = new VirtualClock();
      const logger = new RecordingLogger();
      const direct = await connectionOf(space);
      space.idle.push(direct);
      const queueOn = (conn: RedisConnection, id: string, log: RecordingLogger) =>
        new RedisChildExecutionQueueRepository(
          conn,
          clock,
          new TestApplicationContext({}, id),
          log,
        );
      return {
        proxy,
        clock,
        logger,
        watched: queueOn(connection, "instance-2", logger),
        direct: queueOn(direct, "instance-1", new RecordingLogger()),
      };
    }

    async function watching(queue: RedisChildExecutionQueueRepository) {
      let wakes = 0;
      const watch = await queue.watchQueued(() => {
        wakes += 1;
      });
      cleanups.push(() => watch.close());
      return { wakes: () => wakes };
    }

    it("warns within the bound, subscribes again, wakes once and hears the next save", async () => {
      await space.reset();
      const { proxy, clock, logger, watched, direct } = await instances();
      const watch = await watching(watched);
      expect(logger.entries).toEqual([]);

      proxy.cut();
      // a ping goes out at the first half of the bound; its answer is due at the second
      await clock.advance(seconds(LIVENESS_SECONDS / 2));
      expect(logger.entries).toEqual([]);
      await clock.advance(seconds(LIVENESS_SECONDS / 2));

      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]).toMatchObject({
        level: LogLevel.Warn,
        code: "child-queue.watch-connection-lost",
      });
      expect(watch.wakes()).toBe(0);

      // a child queued once the connection is known to be dead: no message reaches the old one
      await direct.saveIfAbsent(child("c-1"));
      await clock.advance(seconds(1));
      await vi.waitFor(() => {
        expect(watch.wakes()).toBe(1);
      }, CONNECTS);
      await direct.saveIfAbsent(child("c-2"));
      await vi.waitFor(() => {
        expect(watch.wakes()).toBe(2);
      }, CONNECTS);
      expect(await direct.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
        executionId: "c-1",
      });
      expect(logger.entries).toHaveLength(1);
    });

    it("a subscription the network swallows gives up within the bound and is retried", async () => {
      await space.reset();
      const { proxy, clock, logger, watched } = await instances();
      const watch = await watching(watched);

      proxy.cut();
      proxy.swallowNew(true);
      await clock.advance(seconds(LIVENESS_SECONDS / 2));
      await clock.advance(seconds(LIVENESS_SECONDS / 2));
      expect(logger.entries).toHaveLength(1);
      await clock.advance(seconds(1));
      // the new connection is swallowed: nothing answers its handshake, so it is dropped at the bound
      await clock.advance(seconds(LIVENESS_SECONDS));
      expect(watch.wakes()).toBe(0);

      proxy.swallowNew(false);
      await clock.advance(seconds(2));
      await vi.waitFor(() => {
        expect(watch.wakes()).toBe(1);
      }, CONNECTS);
    });
  },
);
