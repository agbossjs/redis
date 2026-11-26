/**
 * #1321e (D6) at the server — what the lease scripts of the cluster do that a double cannot show:
 * the counter that never goes down (`RAISE_EPOCH`), a Redis that lost its keys catching up with the
 * database's row, a lease key never given an expiry (a paused tree's release included), and the
 * marks' cache that only escalates however late or repeated the pushes are, signalled on a channel.
 * The database's row is the authority throughout: Redis is emptied and the marks are still read.
 */
import { InterruptMode, StoreClock, StoreTimeSource } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RedisConnection } from "../../src/index.js";
import { RedisExecutionLeaseRepository } from "../../src/index.js";
import {
  leaseKeyOf,
  marksChannelOf,
  marksKeyOf,
  RedisClusterCoordinator,
} from "../../src/stores/leases/redis-cluster-coordinator.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionOf, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const LEASE = seconds(30);
const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;
const CLOCK = new StoreClock(StoreTimeSource.Database, { now: () => new Date() });

describe.skipIf(DURABLE_URL === "")("#1321e: the cluster's lease scripts on a server", () => {
  const space = testKeySpace("cluster-lease");
  let connection: RedisConnection;

  const coordinatorOf = (instanceId: string) =>
    new RedisClusterCoordinator(connection, CLOCK, new TestApplicationContext(instanceId));
  const storeOf = (instanceId: string) =>
    new RedisExecutionLeaseRepository(
      connection,
      CLOCK,
      new TestApplicationContext(instanceId),
      space.keptIds,
    );
  const leaseKey = () => leaseKeyOf(space.prefix, TREE.tenantId, TREE.rootExecutionId);

  beforeEach(async () => {
    await space.reset();
    connection = await connectionOf(space);
    space.idle.push(connection);
  });
  afterAll(async () => {
    await space.close();
  });

  it("raiseEpoch makes a key it never saw released at that token: the next take is token + 1, no takeover", async () => {
    const coordinator = coordinatorOf("a");

    await coordinator.raiseEpoch(TREE, 7);
    const taken = await coordinator.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);

    expect(taken).toMatchObject({ token: 8, holderInstanceId: "a" });
    expect(taken).not.toHaveProperty("takenOverFrom");
  });

  it("raiseEpoch never lowers the counter, and a retired key stays retired", async () => {
    const coordinator = coordinatorOf("a");
    const held = await coordinator.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);
    if (held === undefined) throw new Error("no lease");

    await coordinator.raiseEpoch(TREE, 0);
    await coordinator.raiseEpoch(TREE, 1);
    expect(await connection.native.hGet(leaseKey(), "e")).toBe("1");
    await coordinator.retire(held);
    await coordinator.raiseEpoch(TREE, 9);

    expect(await connection.native.hGet(leaseKey(), "s")).toBe("f");
    expect(await coordinator.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE)).toBeUndefined();
  });

  it("a stale holder is fenced by a raised counter: its renewal is refused, nobody else takes the live key", async () => {
    const stale = coordinatorOf("a");
    const held = await stale.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);
    if (held === undefined) throw new Error("no lease");

    await coordinatorOf("b").raiseEpoch(TREE, 5);

    expect(await stale.renew(held, LEASE)).toBeUndefined();
    expect(
      await coordinatorOf("b").acquire(TREE.tenantId, TREE.rootExecutionId, LEASE),
    ).toBeUndefined();
  });

  it("a Redis emptied under a database row at token 4 never hands out a token at or below it", async () => {
    const store = storeOf("a");
    for (let round = 0; round < 4; round += 1) {
      const held = await store.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);
      if (held === undefined) throw new Error("no lease");
      await store.release(held);
    }
    expect(await space.keptIds.mirroredLeaseOf(TREE)).toMatchObject({ token: 4 });

    await connection.native.flushDb();
    const next = await storeOf("b").acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);

    expect(next?.token).toBe(5);
    expect(await space.keptIds.mirroredLeaseOf(TREE)).toMatchObject({
      token: 5,
      holderInstanceId: "b",
      state: "held",
    });
  });

  it("a lease key has no expiry: not when held, not when released, not on a paused tree's release", async () => {
    const store = storeOf("a");
    const held = await store.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);
    if (held === undefined) throw new Error("no lease");
    expect(await connection.native.pTTL(leaseKey())).toBe(-1);

    await store.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "ops" });
    await store.release(held);

    expect(await connection.native.pTTL(leaseKey())).toBe(-1);
    expect(await connection.native.pTTL(marksKeyOf(space.prefix, TREE))).toBe(-1);
  });

  it("the marks' cache only escalates: a late push of fewer marks lowers none of them", async () => {
    const coordinator = coordinatorOf("a");
    const key = marksKeyOf(space.prefix, TREE);

    await coordinator.publishMarks(TREE, {
      isCancelRequested: true,
      stop: { mode: InterruptMode.Immediate },
      fencedThroughToken: 5,
    });
    await coordinator.publishMarks(TREE, {
      isCancelRequested: false,
      stop: { mode: InterruptMode.AfterStep },
      fencedThroughToken: 3,
    });

    expect(await connection.native.hGetAll(key)).toEqual({ c: "1", s: "immediate", f: "5" });
  });

  it("the pause is the one mark that is lifted, and while it is set its mode only escalates", async () => {
    const coordinator = coordinatorOf("a");
    const key = marksKeyOf(space.prefix, TREE);
    const paused = (mode: InterruptMode) => ({
      isCancelRequested: false,
      pause: { mode, reason: "ops" },
    });

    await coordinator.publishMarks(TREE, paused(InterruptMode.Immediate));
    await coordinator.publishMarks(TREE, paused(InterruptMode.AfterStep));
    expect(await connection.native.hGet(key, "p")).toBe("immediate");
    await coordinator.publishMarks(TREE, { isCancelRequested: false });

    expect(await connection.native.hExists(key, "p")).toBe(0);
    expect(await connection.native.hExists(key, "r")).toBe(0);
  });

  it("each push is signalled on the marks' channel with the tree's lease key", async () => {
    const subscriber = connection.subscriber();
    await subscriber.connect();
    const messages: string[] = [];
    await subscriber.subscribe(marksChannelOf(space.prefix), (message) => {
      messages.push(message);
    });
    try {
      await storeOf("a").requestStop(TREE, InterruptMode.AfterStep);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await subscriber.close();
    }

    expect(messages).toEqual([leaseKey()]);
  });

  it("every mark is read from the database: a Redis emptied after the marks loses none of them", async () => {
    const store = storeOf("a");
    await store.acquire(TREE.tenantId, TREE.rootExecutionId, LEASE);
    await store.requestCancel(TREE);
    await store.requestStop(TREE, InterruptMode.Immediate);
    await store.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "ops" });

    await connection.native.flushDb();

    expect(await storeOf("b").markedOf(TREE)).toMatchObject({
      isCancelRequested: true,
      stop: { mode: InterruptMode.Immediate },
      pause: { mode: InterruptMode.Immediate },
      fencedThroughToken: 1,
    });
  });
});
