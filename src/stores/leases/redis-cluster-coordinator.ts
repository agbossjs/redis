import type { ApplicationContext, ExecutionLease, ExecutionTree, StoreClock } from "@agboss/core";
import type { ClusterLeaseCoordinator } from "@agboss/core/stores";
import type { TreeMarks } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import type { RedisConnection } from "../../connection/redis-connection.js";
import { keyOf, runScript, type RedisScript } from "../../connection/scripts.js";
import { storeNowArgumentOf } from "../store-time.js";
import {
  ACQUIRE,
  CLOSE,
  PUBLISH_MARKS,
  RAISE_EPOCH,
  RECLAIM,
  RENEW,
  YIELD,
} from "./lease-scripts.js";

const Taken = z.union([
  z.tuple([z.number(), z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number(), z.string(), z.number()]),
]);
const Reclaimed = z.tuple([z.number(), z.number(), z.number()]);
const Remaining = z.number();

/** A lease's time left as the server answered it: whole ms, never below 0. */
const remainingOf = (value: number): Milliseconds => Math.max(0, Math.floor(value)) as Milliseconds;

/** The channel every push of marks is signalled on (D6): its message is the tree's lease key. */
export const marksChannelOf = (keyPrefix: string): string => `${keyPrefix}lease-marks`;

/** The key of the tree's cached marks. */
export const marksKeyOf = (keyPrefix: string, tree: ExecutionTree): string =>
  keyOf(keyPrefix, "lease-marks", tree.tenantId, tree.rootExecutionId);

/** The key of the tree's lease hash. */
export const leaseKeyOf = (keyPrefix: string, tenantId: string, rootExecutionId: string): string =>
  keyOf(keyPrefix, "lease", tenantId, rootExecutionId);

/**
 * What the cluster does of a tree's lease, on Redis (agbossjs/agboss#693, #1321e, D6): the liveness
 * — who holds it, until when, its token counter — as one Lua script per operation, so each change
 * is atomic and monotonic (the counter never goes down, a lease is live while `x > now` only), and
 * the cache and signal of the marks. It is **no authority** for a token, a stop mark, an external
 * pause or the fence: the database's lease row is, written before this answers
 * (`ClusterExecutionLeaseRepository` owns the order); every key here may be lost and the database
 * still refuses a stale writer. Expiry is decided by the server's own `TIME`, read inside the script
 * (agbossjs/agboss#533; a test's clock when one is injected). A lease key is never deleted nor given
 * an expiry — also none on a paused tree's release — and the connection refuses a server that may
 * evict keys.
 */
export class RedisClusterCoordinator implements ClusterLeaseCoordinator {
  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: StoreClock,
    private readonly applicationContext: ApplicationContext,
  ) {}

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const holderInstanceId = this.applicationContext.instanceId;
    const reply = await this.#run(ACQUIRE, tenantId, rootExecutionId, [
      holderInstanceId,
      String(duration),
      storeNowArgumentOf(this.clock),
    ]);
    if (reply === null) return undefined;
    const parsed = Taken.parse(reply);
    const [token, expires, remaining] = parsed;
    const taken = {
      ...{ tenantId, rootExecutionId, holderInstanceId, token },
      ...{ expiresAt: new Date(expires), remaining: remainingOf(remaining) },
    };
    // five values: a lease that expired without a release, taken over from its holder
    return parsed.length === 3
      ? taken
      : { ...taken, takenOverFrom: { holderInstanceId: parsed[3], token: parsed[4] } };
  }

  async renew(held: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    const reply = await this.#run(RENEW, held.tenantId, held.rootExecutionId, [
      ...this.#heldBy(held),
      String(duration),
      storeNowArgumentOf(this.clock),
    ]);
    return reply === null ? undefined : remainingOf(Remaining.parse(reply));
  }

  async release(held: ExecutionLease): Promise<void> {
    await this.#run(CLOSE, held.tenantId, held.rootExecutionId, [...this.#heldBy(held), "r"]);
  }

  async retire(held: ExecutionLease): Promise<void> {
    await this.#run(CLOSE, held.tenantId, held.rootExecutionId, [...this.#heldBy(held), "f"]);
  }

  async yield(held: ExecutionLease): Promise<Milliseconds | undefined> {
    const reply = await this.#run(YIELD, held.tenantId, held.rootExecutionId, [
      ...this.#heldBy(held),
      storeNowArgumentOf(this.clock),
    ]);
    return reply === null ? undefined : remainingOf(Remaining.parse(reply));
  }

  async reclaim(held: ExecutionLease, duration: Milliseconds): Promise<ExecutionLease | undefined> {
    const reply = await this.#run(RECLAIM, held.tenantId, held.rootExecutionId, [
      ...this.#heldBy(held),
      String(duration),
      storeNowArgumentOf(this.clock),
    ]);
    if (reply === null) return undefined;
    const [token, expires, remaining] = Reclaimed.parse(reply);
    const { tenantId, rootExecutionId, holderInstanceId } = held;
    return {
      ...{ tenantId, rootExecutionId, holderInstanceId, token },
      ...{ expiresAt: new Date(expires), remaining: remainingOf(remaining) },
    };
  }

  async raiseEpoch(tree: ExecutionTree, atLeast: number): Promise<void> {
    await this.#run(RAISE_EPOCH, tree.tenantId, tree.rootExecutionId, [String(atLeast)]);
  }

  async publishMarks(tree: ExecutionTree, marks: TreeMarks): Promise<void> {
    const prefix = this.connection.keyPrefix;
    await runScript(
      this.connection.client,
      PUBLISH_MARKS,
      [marksKeyOf(prefix, tree)],
      [
        marks.isCancelRequested ? "1" : "0",
        marks.stop?.mode ?? "",
        marks.pause?.mode ?? "",
        marks.pause?.reason ?? "",
        marks.fencedThroughToken === undefined ? "" : String(marks.fencedThroughToken),
        marksChannelOf(prefix),
        leaseKeyOf(prefix, tree.tenantId, tree.rootExecutionId),
      ],
    );
  }

  /** The holder and token a script matches. */
  #heldBy(lease: ExecutionLease): readonly [string, string] {
    return [lease.holderInstanceId, String(lease.token)];
  }

  #run(
    script: RedisScript,
    tenantId: string,
    rootExecutionId: string,
    args: readonly string[],
  ): Promise<unknown> {
    const key = leaseKeyOf(this.connection.keyPrefix, tenantId, rootExecutionId);
    return runScript(this.connection.client, script, [key], args);
  }
}
