/**
 * agbossjs/agboss#777 — the Redis child queue's watch on the real server, beyond the core's
 * contract cases (`QUEUE_WATCH_CASES`, run by `storeConformance`): a child queued by another
 * process wakes it; a dropped subscription reconnects, subscribes again and wakes when back —
 * for the message it lost while down —; a closed watch wakes nothing; a server that does not answer
 * rejects the watch (the core opens it again at its next sweep, its floor for any lost wake-up).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { afterAll, describe, expect, it } from "vitest";
import { RedisChildExecutionQueueRepository, RedisConnection } from "../../src/index.js";
import { openQueueWatch } from "../../src/stores/queue/queue-watch.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionOf, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL("../support/queue-save.child.mjs", import.meta.url));

/** Wake-ups to wait for, counted: `next()` resolves at the next one (the test's timeout bounds it). */
function wakeUps(): {
  readonly onQueued: () => void;
  next(): Promise<void>;
  /** Forgets the wake-ups not yet awaited: the next `next()` waits for one from now on. */
  fresh(): void;
  readonly count: number;
} {
  let count = 0;
  let woken: () => void = () => undefined;
  let pending = new Promise<void>((resolve) => (woken = resolve));
  return {
    onQueued: () => {
      count += 1;
      woken();
    },
    next: async () => {
      await pending;
      pending = new Promise<void>((resolve) => (woken = resolve));
    },
    fresh: () => {
      pending = new Promise<void>((resolve) => (woken = resolve));
    },
    get count() {
      return count;
    },
  };
}

const child = (executionId: string): QueuedChildExecution => ({
  ...{ tenantId: "default", executionId, rootExecutionId: "root-1", parentExecutionId: "root-1" },
  ...{ rootWorkflow: "root-workflow", workflow: "child-workflow", depth: 2, run: "{}" },
  ...{ status: ExecutionRecordStatus.Queued, queuedAt: new Date(0) },
});

const clock = { now: () => new Date(0), sleep: () => Promise.resolve(), monotonicNow: () => 0 };

describe.skipIf(DURABLE_URL === "")("agbossjs/agboss#777: the Redis child queue's watch", () => {
  const space = testKeySpace("queue-watch");

  afterAll(async () => {
    await space.close();
  });

  const queueOf = async (instanceId: string) => {
    const connection = await connectionOf(space);
    space.idle.push(connection);
    const context = new TestApplicationContext({}, instanceId);
    return {
      connection,
      queue: new RedisChildExecutionQueueRepository(connection, clock, context),
    };
  };

  it("a child queued by another process wakes the watch; it is claimed on the wake-up", async () => {
    await space.reset();
    const { queue } = await queueOf("instance-2");
    const wake = wakeUps();
    const watch = await queue.watchQueued(wake.onQueued);
    try {
      const { stdout } = await run(process.execPath, [CHILD, DURABLE_URL, space.prefix, "c-1"]);
      expect(stdout).toBe("saved true\n");
      await wake.next();
      expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
        executionId: "c-1",
        instanceId: "instance-2",
      });
    } finally {
      await watch.close();
    }
  });

  it("a dropped subscription subscribes again and wakes for what it lost, then wakes as before", async () => {
    await space.reset();
    const { connection, queue } = await queueOf("instance-2");
    const other = await queueOf("instance-1");
    const subscriber = connection.subscriber();
    await subscriber.connect();
    const id = await subscriber.clientId();
    const wake = wakeUps();
    const watch = await openQueueWatch(subscriber, `${space.prefix}child-queued`, wake.onQueued);
    // a channel of its own: messages of one connection arrive in order, so its message fences them
    let arrived: () => void = () => undefined;
    const fenced = new Promise<void>((resolve) => (arrived = resolve));
    await subscriber.subscribe(`${space.prefix}fence`, () => {
      arrived();
    });
    try {
      await other.connection.client.clientKill({ filter: "ID", id });
      // right after the kill: node-redis reconnects at once (~5 ms), so this save is lost by pub/sub
      // or delivered after the new subscription — the wake-up on `ready` stands for it either way
      expect(await other.queue.saveIfAbsent(child("lost-1"))).toBe(true);
      await wake.next();
      expect(await queue.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
        executionId: "lost-1",
      });
      await other.connection.client.publish(`${space.prefix}fence`, "back");
      await fenced;
      const before = wake.count;
      expect(before).toBeGreaterThanOrEqual(1);

      // subscribed again: the next save wakes it as before
      wake.fresh();
      await other.queue.saveIfAbsent(child("c-2"));
      await wake.next();
      expect(wake.count).toBe(before + 1);
    } finally {
      await watch.close();
    }
  });

  it("a closed watch wakes nothing, and closes once", async () => {
    await space.reset();
    const { queue } = await queueOf("instance-2");
    const other = await queueOf("instance-1");
    const [closed, open] = [wakeUps(), wakeUps()];
    const watch = await queue.watchQueued(closed.onQueued);
    const witness = await queue.watchQueued(open.onQueued);
    await watch.close();
    await watch.close();

    await other.queue.saveIfAbsent(child("c-1"));
    await open.next(); // the save's message has been delivered
    await witness.close();
    expect(closed.count).toBe(0);
  });

  it("a server that does not answer rejects the watch at once (the core retries at its sweep)", async () => {
    const connection = new RedisConnection({ url: "redis://127.0.0.1:1", keyPrefix: space.prefix });
    const queue = new RedisChildExecutionQueueRepository(
      connection,
      clock,
      new TestApplicationContext({}),
    );
    await expect(queue.watchQueued(() => undefined)).rejects.toThrow();
  });
});
