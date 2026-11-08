import {
  ApplicationContext,
  ExecutionLeaseRepository,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionLease,
  type StoreDescriptor,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import type { RedisConnection } from "../connection/redis-connection.js";
import { keyOf, runScript, type RedisScript } from "../connection/scripts.js";
import { ACQUIRE, CLOSE, RECLAIM, RENEW, YIELD } from "./leases/lease-scripts.js";
import { storeNowArgumentOf } from "./store-time.js";

/**
 * Where a Redis lease store keeps the execution ids it is asked to keep (#591): never in Redis —
 * the maintainer's decision for #527 keeps them with the durable rows (PostgreSQL, MongoDB): the
 * application's own durable lease store, which keeps them forever with one insert-if-absent.
 */
export type KeptExecutionIds = Pick<ExecutionLeaseRepository, "claimExecutionId">;

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
 * **Coordination only** (`static backend = "redis"`): the core's one-backend check (#526) refuses a
 * fenced-effect or outbound-call store on another backend beside it — their write must check the
 * lease in its own transaction, which Redis and PostgreSQL cannot share. An application on these
 * leases lists none of them.
 *
 * **The kept ids** live where the application's durable rows live: a subclass gives the store that
 * keeps them (its PostgreSQL or MongoDB lease store) — the class is abstract so that it is chosen:
 *
 * ```ts
 * @Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext, PostgresConnection] })
 * class AppExecutionLeases extends RedisExecutionLeaseRepository {
 *   constructor(redis: RedisConnection, clock: StoreClock, app: ApplicationContext, pg: PostgresConnection) {
 *     super(redis, clock, app, new PostgresExecutionLeaseRepository(pg, clock, app));
 *   }
 * }
 * ```
 */
export abstract class RedisExecutionLeaseRepository extends ExecutionLeaseRepository {
  /** Its own backend: no fencing store of another one may be listed beside it (#526). */
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: StoreClock,
    private readonly applicationContext: ApplicationContext,
    private readonly keptIds: KeptExecutionIds,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  /** Kept by the durable store the subclass names, never in Redis (#527). */
  claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.keptIds.claimExecutionId(identity);
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
