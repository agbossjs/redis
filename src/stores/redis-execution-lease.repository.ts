import {
  ApplicationContext,
  EXECUTION_ID_STORE,
  ExecutionLeaseRepository,
  Injectable,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionIdStore,
  type ExecutionLease,
  type StoreDescriptor,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import { RedisConnection } from "../connection/redis-connection.js";
import { keyOf, runScript, type RedisScript } from "../connection/scripts.js";
import { ACQUIRE, CLOSE, RECLAIM, RENEW, YIELD } from "./leases/lease-scripts.js";
import { storeNowArgumentOf } from "./store-time.js";

const Taken = z.union([
  z.tuple([z.number(), z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number(), z.string(), z.number()]),
]);
const Reclaimed = z.tuple([z.number(), z.number(), z.number()]);
const Remaining = z.number();

/** A lease's time left as the server answered it: whole ms, never below 0. */
const remainingOf = (value: number): Milliseconds => Math.max(0, Math.floor(value)) as Milliseconds;

/**
 * `ExecutionLeaseRepository` on Redis (agbossjs/agboss#693): one hash per tree, every operation one
 * Lua script (`leases/lease-scripts.ts`) — Redis runs it alone, so of two instances exactly one
 * takes a free lease and a renewal never wins against a takeover. Expiry is decided by the server's
 * own `TIME`, read inside the script (agbossjs/agboss#533; a test's clock when one is injected),
 * and every take and renewal answers `remaining` on that clock. Epochs only grow: a lease key is
 * never deleted nor expired, and the connection refuses a server that may evict keys.
 *
 * **Coordination only** (`static store = { backend: "redis" }`): the core's one-backend check
 * (#526) refuses a fenced-effect or outbound-call store on another backend beside it — their write
 * must check the lease in its own transaction, which Redis and PostgreSQL cannot share. An
 * application on these leases lists none of them.
 *
 * **The execution ids** it hands out (agbossjs/agboss#591) are never kept in Redis
 * (agbossjs/agboss#527): they live where the application's durable rows live — the store the
 * application gives under `EXECUTION_ID_STORE` (agbossjs/agboss#891), its PostgreSQL or MongoDB
 * lease store, created by the container under that token only (no second lease store, no `new`):
 *
 * ```ts
 * providers: [
 *   ...REDIS_COORDINATION_STORES,
 *   provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository),
 * ]
 * ```
 */
@Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext, EXECUTION_ID_STORE] })
export class RedisExecutionLeaseRepository extends ExecutionLeaseRepository {
  /** Its own backend: no fencing store of another one may be listed beside it (#526). */
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: StoreClock,
    private readonly applicationContext: ApplicationContext,
    private readonly executionIds: ExecutionIdStore,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  /** Kept by the durable store under `EXECUTION_ID_STORE`, never in Redis (#527, #891). */
  claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.executionIds.claimExecutionId(identity);
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
    const [token, expires, remaining, previousHolder, previousEpoch] = Taken.parse(reply);
    const taken = {
      ...{ tenantId, rootExecutionId, holderInstanceId, token },
      ...{ expiresAt: new Date(expires), remaining: remainingOf(remaining) },
    };
    return previousHolder === undefined || previousEpoch === undefined
      ? taken
      : {
          ...taken,
          takenOverFrom: { holderInstanceId: previousHolder, token: previousEpoch },
        };
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
    const key = keyOf(this.connection.keyPrefix, "lease", tenantId, rootExecutionId);
    return runScript(this.connection.client, script, [key], args);
  }
}
