import { StoreClock, StoreTimeSource, type ExecutionLease } from "@agboss/core";
import { InterruptMode } from "@agboss/core";
import {
  ClusterExecutionLeaseRepository,
  ClusterLeaseSyncOutcome,
  StoreError,
} from "@agboss/core/stores";
import { seconds } from "@agboss/core/units";
import { afterEach, describe, expect, it } from "vitest";
import type { RedisConnection } from "../../src/index.js";
import { RedisExecutionLeaseRepository } from "../../src/index.js";
import { RedisLeaseKeyConflictError } from "../../src/errors.js";
import { keyOf } from "../../src/connection/scripts.js";
import {
  ACQUIRE,
  CLOSE,
  PUBLISH_MARKS,
  RAISE_EPOCH,
} from "../../src/stores/leases/lease-scripts.js";
import {
  leaseKeyOf,
  marksChannelOf,
  marksKeyOf,
  RedisClusterCoordinator,
} from "../../src/stores/leases/redis-cluster-coordinator.js";
import { TestApplicationContext } from "../support/application-context.js";
import { scriptedConnection, type ScriptRun } from "../support/scripted-connection.js";
import { SharedKeptIds } from "../support/redis-store.js";

/**
 * D6 (#1321e): the Redis side of a cluster lease — what the coordinator sends the server, and the
 * composition with the database's row (the core's `ClusterExecutionLeaseRepository`), on a scripted
 * client and the real SQLite lease store as the database: no server needed. The scripts' own
 * behaviour on a server (monotonic counter, marks that only escalate) is in the integration tests.
 */

const LEASE = seconds(30);
const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;
const PREFIX = "t:";
const CLOCK = new StoreClock(StoreTimeSource.Test, { now: () => new Date(1_000) });

const NAMES = new Map<string, string>(
  Object.entries({ ACQUIRE, CLOSE, PUBLISH_MARKS, RAISE_EPOCH }).map(([name, script]) => [
    script.sha,
    name,
  ]),
);

/** A connection whose scripts answer what `reply` says, recording each run by its script's name. */
function scripted(reply: (call: ScriptRun) => unknown, exists = 0) {
  const { connection, runs } = scriptedConnection(reply, {
    ...{ keyPrefix: PREFIX, exists },
    names: NAMES,
  });
  return { connection, calls: runs };
}

const application = (id: string) => new TestApplicationContext({}, id);

describe("the cluster's lease on Redis: the coordinator", () => {
  it("raises the counter to the row's token with RAISE_EPOCH on the tree's lease key", async () => {
    const { connection, calls } = scripted(() => 7);

    await new RedisClusterCoordinator(connection, CLOCK, application("a")).raiseEpoch(TREE, 7);

    expect(calls).toEqual([
      {
        script: "RAISE_EPOCH",
        keys: [keyOf(PREFIX, "lease", "default", "root-1")],
        args: ["7"],
      },
    ]);
  });

  it("pushes the marks as the database holds them: cache key, channel, tree key", async () => {
    const { connection, calls } = scripted(() => 1);
    const coordinator = new RedisClusterCoordinator(connection, CLOCK, application("a"));

    await coordinator.publishMarks(TREE, {
      isCancelRequested: true,
      stop: { mode: InterruptMode.Immediate },
      pause: { mode: InterruptMode.AfterStep, reason: "ops" },
      fencedThroughToken: 4,
    });
    await coordinator.publishMarks(TREE, { isCancelRequested: false });

    expect(calls.map((call) => call.keys)).toEqual([
      [marksKeyOf(PREFIX, TREE)],
      [marksKeyOf(PREFIX, TREE)],
    ]);
    expect(calls[0]?.args).toEqual([
      ...["1", "immediate", "after-step", "ops", "4"],
      ...[marksChannelOf(PREFIX), leaseKeyOf(PREFIX, "default", "root-1")],
    ]);
    expect(calls[1]?.args).toEqual([
      ...["0", "", "", "", ""],
      ...[marksChannelOf(PREFIX), leaseKeyOf(PREFIX, "default", "root-1")],
    ]);
  });

  it("a take names its previous holder only for a lease that expired unreleased", async () => {
    const replies: unknown[] = [[3, 31_000, 30_000], [4, 61_000, 30_000, "b", 3], null];
    const { connection } = scripted(() => replies.shift());
    const coordinator = new RedisClusterCoordinator(connection, CLOCK, application("a"));

    const fresh = await coordinator.acquire("default", "root-1", LEASE);
    const takeover = await coordinator.acquire("default", "root-1", LEASE);
    const refused = await coordinator.acquire("default", "root-1", LEASE);

    expect(fresh).toMatchObject({ token: 3, holderInstanceId: "a" });
    expect(fresh).not.toHaveProperty("takenOverFrom");
    expect(takeover).toMatchObject({
      token: 4,
      takenOverFrom: { holderInstanceId: "b", token: 3 },
    });
    expect(refused).toBeUndefined();
  });

  it("an answer that is no lease is no lease: the take fails closed", async () => {
    const { connection } = scripted(() => ["not", "a", "lease"]);

    await expect(
      new RedisClusterCoordinator(connection, CLOCK, application("a")).acquire(
        "default",
        "root-1",
        LEASE,
      ),
    ).rejects.toThrow();
  });
});

describe("the lease store on Redis beside the database's row (D6)", () => {
  const durables: SharedKeptIds[] = [];
  const durableOf = (): SharedKeptIds => {
    const durable = new SharedKeptIds();
    durables.push(durable);
    return durable;
  };
  afterEach(() => {
    for (const durable of durables.splice(0)) durable.close();
  });

  const storeOf = (connection: RedisConnection, durable: SharedKeptIds) =>
    new RedisExecutionLeaseRepository(connection, CLOCK, application("a"), durable);

  it("is a cluster lease store on its own backend", () => {
    expect(RedisExecutionLeaseRepository.prototype).toBeInstanceOf(ClusterExecutionLeaseRepository);
    expect(RedisExecutionLeaseRepository.store).toEqual({ backend: "redis" });
  });

  it("a Redis behind the row: the take is given back, the counter raised past the row, then it takes the next token", async () => {
    const durable = durableOf();
    // the row is at token 7, held and then released by another holder
    const ahead: ExecutionLease = {
      ...{ tenantId: "default", rootExecutionId: "root-1", holderInstanceId: "b", token: 7 },
      ...{ expiresAt: new Date(0), remaining: LEASE },
    };
    await durable.syncClusterLease(ahead);
    await durable.endClusterLease(ahead, { isRetired: false });
    // Redis lost its keys: its counter starts again, and answers 8 once it was raised past 7
    const { connection, calls } = scripted((call) => {
      if (call.script === "ACQUIRE")
        return calls.filter((one) => one.script === "ACQUIRE").length === 1
          ? [1, 31_000, 30_000]
          : [8, 61_000, 30_000];
      return 1;
    });

    const taken = await storeOf(connection, durable).acquire("default", "root-1", LEASE);

    expect(taken).toMatchObject({ token: 8, holderInstanceId: "a" });
    expect(calls.map((call) => call.script)).toEqual([
      "ACQUIRE",
      "CLOSE",
      "RAISE_EPOCH",
      "ACQUIRE",
    ]);
    expect(calls[1]?.args.slice(0, 2)).toEqual(["a", "1"]);
    expect(calls[2]?.args).toEqual(["7"]);
    expect(await durable.mirroredLeaseOf(TREE)).toMatchObject({ token: 8, state: "held" });
  });

  it("a Redis that stays behind after every catch-up fails closed: ClusterLeaseBehind, nothing handed out", async () => {
    const durable = durableOf();
    const ahead: ExecutionLease = {
      ...{ tenantId: "default", rootExecutionId: "root-1", holderInstanceId: "b", token: 9 },
      ...{ expiresAt: new Date(0), remaining: LEASE },
    };
    await durable.syncClusterLease(ahead);
    await durable.endClusterLease(ahead, { isRetired: false });
    const { connection, calls } = scripted((call) =>
      call.script === "ACQUIRE" ? [1, 31_000, 30_000] : 1,
    );

    await expect(
      storeOf(connection, durable).acquire("default", "root-1", LEASE),
    ).rejects.toMatchObject({ code: "store.cluster-lease-behind" });

    // three takes, each given back and followed by a raise; the row never moved
    expect(calls.filter((call) => call.script === "ACQUIRE")).toHaveLength(3);
    expect(calls.filter((call) => call.script === "RAISE_EPOCH")).toHaveLength(3);
    expect(await durable.mirroredLeaseOf(TREE)).toMatchObject({ token: 9, state: "released" });
  });

  it("a release is in the row before the key changes: the row already says released when the CLOSE script runs", async () => {
    const durable = durableOf();
    const taking = scripted(() => [1, 31_000, 30_000]);
    const held = await storeOf(taking.connection, durable).acquire("default", "root-1", LEASE);
    if (held === undefined) throw new Error("no lease");
    let rowAtClose: unknown;
    const closing = scripted(() => {
      rowAtClose = durable.mirroredLeaseOf(TREE);
      return 1;
    });

    await storeOf(closing.connection, durable).release(held);

    expect(await rowAtClose).toMatchObject({ state: "released", token: 1 });
    expect(closing.calls.map((call) => call.script)).toEqual(["CLOSE"]);
    expect(closing.calls[0]?.args).toEqual(["a", "1", "r"]);
  });

  it("a mark is in the row before Redis is told: the cancel read at the time of the push is already set", async () => {
    const durable = durableOf();
    let seen: unknown;
    const { connection, calls } = scripted((call) => {
      if (call.script === "PUBLISH_MARKS") seen = durable.isCancelRequested(TREE);
      return 1;
    });

    await storeOf(connection, durable).requestCancel(TREE);

    expect(await seen).toBe(true);
    expect(calls.map((call) => call.script)).toEqual(["PUBLISH_MARKS"]);
    expect(calls[0]?.args[0]).toBe("1");
  });

  it("a Redis that is down rejects the call after the mark is durable; every read of a mark is the row's", async () => {
    const durable = durableOf();
    const { connection } = scripted(() => Promise.reject(new Error("Redis is down")));
    const store = storeOf(connection, durable);

    // a write script that fails after the send is of unknown outcome (#1017): a repeat pushes again
    await expect(store.requestStop(TREE, InterruptMode.Immediate)).rejects.toBeInstanceOf(
      StoreError.OutcomeUnknown,
    );

    expect(await store.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
    expect((await store.markedOf(TREE)).stop).toEqual({ mode: InterruptMode.Immediate });
  });

  it("a pause pushes the fence the row raised; unpause pushes the lifted pause with the fence kept", async () => {
    const durable = durableOf();
    const { connection, calls } = scripted((call) =>
      call.script === "ACQUIRE" ? [3, 31_000, 30_000] : 1,
    );
    const store = storeOf(connection, durable);
    await store.acquire("default", "root-1", LEASE);

    await store.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "ops" });
    await store.unpause(TREE);

    const pushes = calls.filter((call) => call.script === "PUBLISH_MARKS");
    expect(pushes[0]?.args.slice(2, 5)).toEqual(["immediate", "ops", "3"]);
    expect(pushes[1]?.args.slice(2, 5)).toEqual(["", "", "3"]);
  });

  it("claims an execution id in the database only; a lease key of a new id is another database's", async () => {
    const durable = durableOf();
    const identity = { executionId: "exec-1", tenantId: "default" };

    const clean = scripted(() => 1, 0);
    expect(await storeOf(clean.connection, durable).claimExecutionId(identity)).toBe(true);
    expect(await storeOf(clean.connection, durable).claimExecutionId(identity)).toBe(false);

    const conflicting = scripted(() => 1, 1);
    await expect(
      storeOf(conflicting.connection, durable).claimExecutionId({
        executionId: "exec-2",
        tenantId: "default",
      }),
    ).rejects.toBeInstanceOf(RedisLeaseKeyConflictError);
    expect(clean.calls).toEqual([]);
  });

  it("the sync outcomes the row answers are the core's vocabulary", () => {
    expect(Object.values(ClusterLeaseSyncOutcome)).toEqual(["synced", "behind", "retired"]);
  });
});
