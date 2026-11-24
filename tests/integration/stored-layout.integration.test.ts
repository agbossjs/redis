/**
 * agbossjs/agboss#1213 — what the stores keep on the server, read back as it is stored: the keys
 * each store writes (the layout two versions of the package share on one server), a completion's
 * failure only when there is one, a stored child row that is no longer a number where a time
 * belongs refused on read, the rate-limit keys' lifetimes covering what is in them, a cleared
 * window gone whole, and every store's `ping()` the server's own answer.
 */
import {
  ChildPlacement,
  ExecutionRecordStatus,
  StoreClock,
  StoreTimeSource,
  type Clock,
  type QueuedChildExecution,
} from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisExecutionLeaseRepository,
  RedisRateLimitRepository,
} from "../../src/index.js";
import { keyOf } from "../../src/connection/scripts.js";
import { TestApplicationContext } from "../support/application-context.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { connectionOf, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const HOUR = 3_600_000;
/** The system's time: what the server's key lifetimes are measured against. */
const systemClock: Clock = {
  now: () => new Date(),
  sleep: () => Promise.resolve(),
  monotonicNow: () => 0,
};

const child = (executionId: string): QueuedChildExecution => ({
  ...{ tenantId: "default", executionId, rootExecutionId: "root-1", parentExecutionId: "root-1" },
  ...{ rootWorkflow: "root-workflow", workflow: "child-workflow", depth: 2, run: "{}" },
  ...{ status: ExecutionRecordStatus.Queued, queuedAt: new Date() },
});

describe.skipIf(DURABLE_URL === "")("agbossjs/agboss#1213: what the stores keep", () => {
  const space = testKeySpace("stored-layout");
  let connection: RedisConnection;

  const queueOn = (on: RedisConnection) =>
    new RedisChildExecutionQueueRepository(
      on,
      systemClock,
      new TestApplicationContext({}),
      new RecordingLogger(),
    );
  const limitsOn = (on: RedisConnection) =>
    new RedisRateLimitRepository(on, systemClock, new TestApplicationContext({}));
  const leasesOn = (on: RedisConnection) =>
    new RedisExecutionLeaseRepository(
      on,
      new StoreClock(StoreTimeSource.Database, systemClock),
      new TestApplicationContext({}),
      space.keptIds,
    );

  beforeEach(async () => {
    await space.reset();
    connection = await connectionOf(space);
    space.idle.push(connection);
  });
  afterAll(async () => {
    await space.close();
  });

  it("the keys each store writes, under the connection's prefix", async () => {
    await leasesOn(connection).acquire("default", "root-1", seconds(30));
    const queue = queueOn(connection);
    await queue.saveIfAbsent(child("child-1"));
    await queue.saveIfAbsent(child("child-2"));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    const limits = limitsOn(connection);
    await limits.acquire("provider-1", 1, seconds(10));
    await limits.addToWindow("provider-1", 1, seconds(60));
    await limits.pauseUntil("provider-1", new Date(Date.now() + 60_000));

    const keys = (await connection.native.keys(`${space.prefix}*`)).sort();

    expect(keys).toEqual(
      [
        keyOf(space.prefix, "child", "default", "child-1"),
        keyOf(space.prefix, "child", "default", "child-2"),
        keyOf(space.prefix, "children-of", "default", "root-1"),
        `${space.prefix}children-queued`,
        `${space.prefix}children-queued-by-time`,
        `${space.prefix}children-running`,
        keyOf(space.prefix, "lease", "default", "root-1"),
        keyOf(space.prefix, "rate-limit-pause", "provider-1"),
        keyOf(space.prefix, "rate-limit-slots", "provider-1"),
        keyOf(space.prefix, "rate-limit-window", "provider-1"),
        keyOf(space.prefix, "rate-limit-window-amounts", "provider-1"),
      ].sort(),
    );
  });

  it("an isolated worker's child is on a queue of its own, with its placement and the instance to skip", async () => {
    const queue = queueOn(connection);
    await queue.saveIfAbsent({ ...child("isolated-1"), placement: ChildPlacement.IsolatedWorker });
    await queue.saveIfAbsent({
      ...child("other-1"),
      ...{ placement: ChildPlacement.OtherWorker, excludeInstanceId: "instance-9" },
    });

    expect(await connection.native.zCard(`${space.prefix}children-queued-isolated`)).toBe(1);
    expect(await connection.native.zCard(`${space.prefix}children-queued`)).toBe(1);
    expect(await connection.native.zCard(`${space.prefix}children-queued-by-time`)).toBe(2);
    expect(
      await connection.native.hGet(
        keyOf(space.prefix, "child", "default", "other-1"),
        "excludeInstanceId",
      ),
    ).toBe("instance-9");
    // the general claim never takes the isolated child: it is the targeted claim's
    expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
      executionId: "other-1",
    });
    expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toBeUndefined();
  });

  it("a tree's marks are one cache key, pushed after the database's row and never read back", async () => {
    const leases = leasesOn(connection);

    await leases.requestCancel({ tenantId: "default", rootExecutionId: "root-1" });

    expect(
      await connection.native.hGetAll(keyOf(space.prefix, "lease-marks", "default", "root-1")),
    ).toEqual({ c: "1" });
  });

  it("a claimed row whose value is a field's name reads back as it was saved", async () => {
    const queue = queueOn(connection);
    // `status`, `queuedAt`: values the reply's names stand beside, never names themselves
    await queue.saveIfAbsent({ ...child("named-1"), run: "status", workflow: "queuedAt" });

    const claimed = await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    expect(claimed).toMatchObject({
      executionId: "named-1",
      run: "status",
      workflow: "queuedAt",
      status: ExecutionRecordStatus.Running,
    });
  });

  it("a completion keeps its failure only when it has one", async () => {
    const queue = queueOn(connection);
    await queue.saveIfAbsent(child("ok-1"));
    await queue.saveIfAbsent(child("failed-1"));
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();
    await queue.claimFirstByStatusQueuedOrderByDepthDesc();

    await queue.completeByTenantIdAndExecutionId("default", "ok-1", {
      status: ExecutionRecordStatus.Answered,
    });
    await queue.completeByTenantIdAndExecutionId("default", "failed-1", {
      status: ExecutionRecordStatus.Failed,
      failure: "the tool failed",
    });

    const ok = await queue.findByTenantIdAndExecutionId("default", "ok-1");
    const failed = await queue.findByTenantIdAndExecutionId("default", "failed-1");
    expect(ok?.failure).toBeUndefined();
    expect(
      await connection.native.hExists(keyOf(space.prefix, "child", "default", "ok-1"), "failure"),
    ).toBe(0);
    expect(failed?.failure).toBe("the tool failed");
  });

  it.each(["12x", "x12", ""])(
    "a stored child row whose queuedAt is %j, no number, is refused on read",
    async (stored) => {
      const queue = queueOn(connection);
      await queue.saveIfAbsent(child("corrupt-1"));
      await connection.native.hSet(keyOf(space.prefix, "child", "default", "corrupt-1"), {
        queuedAt: stored,
      });

      await expect(queue.findByTenantIdAndExecutionId("default", "corrupt-1")).rejects.toThrow();
    },
  );

  it("a renewed slot's key lives past the slot, and no longer than an hour more", async () => {
    const limits = limitsOn(connection);
    const lease = await limits.acquire("provider-1", 1, seconds(10));
    if (lease === undefined) throw new Error("a free slot is taken");

    // renewed for longer than the key's hour past its first end: the key's life grows with it
    expect(await limits.renew(lease, seconds(7200))).toBe(true);

    const ttl = await connection.native.pTTL(keyOf(space.prefix, "rate-limit-slots", "provider-1"));
    expect(ttl).toBeGreaterThan(7_200_000);
    expect(ttl).toBeLessThanOrEqual(7_200_000 + HOUR);
  });

  it("a pause's key lives past the pause, and no longer than an hour more", async () => {
    const limits = limitsOn(connection);
    const until = new Date(Date.now() + 3 * HOUR);

    await limits.pauseUntil("provider-1", until);

    const ttl = await connection.native.pTTL(keyOf(space.prefix, "rate-limit-pause", "provider-1"));
    expect(ttl).toBeGreaterThan(3 * HOUR);
    expect(ttl).toBeLessThanOrEqual(4 * HOUR);
    expect(await limits.pausedUntil("provider-1")).toEqual(until);
  });

  it("no pause, or a pause that ended, is no pause", async () => {
    const limits = limitsOn(connection);

    expect(await limits.pausedUntil("provider-1")).toBeUndefined();
    await limits.pauseUntil("provider-1", new Date(Date.now() - 1_000));
    expect(await limits.pausedUntil("provider-1")).toBeUndefined();
  });

  it("a cleared window is gone whole: its next count starts from nothing", async () => {
    const limits = limitsOn(connection);
    await limits.addToWindow("provider-1", 3, seconds(60));

    await limits.clearWindow("provider-1");

    expect(
      await connection.native.exists([
        keyOf(space.prefix, "rate-limit-window", "provider-1"),
        keyOf(space.prefix, "rate-limit-window-amounts", "provider-1"),
      ]),
    ).toBe(0);
    expect(await limits.addToWindow("provider-1", 2, seconds(60))).toBe(2);
  });

  it("every store's ping() is the server's answer: on a closed connection it rejects", async () => {
    const closing = await connectionOf(space);
    const stores = [queueOn(closing), limitsOn(closing), leasesOn(closing)];
    for (const store of stores) await store.ping();

    await closing.onDestroy();

    for (const store of stores) await expect(store.ping()).rejects.toThrow();
  });
});
