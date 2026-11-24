import {
  type ExecutionIdStore,
  StoreClock,
  StoreTimeSource,
  type ApplicationContext,
  type Clock,
  type ExecutionLease,
  type StoreDescriptor,
} from "@agboss/core";
import { ClusterExecutionLeaseRepository } from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import type { RedisConnection } from "../../../src/index.js";
import {
  leaseKeyOf,
  RedisClusterCoordinator,
} from "../../../src/stores/leases/redis-cluster-coordinator.js";

/**
 * agbossjs/agboss#693 AC3 — Redis lease stores broken the two ways a port to Redis gets wrong, each
 * of which the core's suites must catch (`sabotage.test.ts`):
 *
 * - **on the caller's clock**: the scripts decide expiry by the instance's own clock (the client
 *   sends its `Date.now()`), not the server's `TIME` — two holders once clocks disagree;
 * - **a take that reads, then writes**: `acquire` as `HGETALL` and then `HSET` in two round trips,
 *   not one script — two instances that read the free lease both take it.
 */

/** The instance's own clock as the store's time: what a client-clock store sends its scripts. */
export const callerStoreClockOf = (clock: Clock): StoreClock =>
  new StoreClock(StoreTimeSource.Host, clock);

/** The cluster's take as a read, then a write: check-then-write on the lease hash. */
class ReadThenWriteCoordinator extends RedisClusterCoordinator {
  constructor(
    private readonly redis: RedisConnection,
    private readonly time: StoreClock,
    private readonly application: ApplicationContext,
  ) {
    super(redis, time, application);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = leaseKeyOf(this.redis.keyPrefix, tenantId, rootExecutionId);
    const row = await this.redis.native.hGetAll(key);
    const now = this.time.now().getTime();
    if (row.s === "f" || (row.s === "h" && Number(row.x) > now)) return undefined;
    const token = Number(row.e ?? "0") + 1;
    const expires = now + duration;
    const holderInstanceId = this.application.instanceId;
    await this.redis.native.hSet(key, {
      ...{ h: holderInstanceId, e: String(token), x: String(expires) },
      ...{ s: "h", y: "0" },
    });
    const taken = {
      ...{ tenantId, rootExecutionId, holderInstanceId, token },
      ...{ expiresAt: new Date(expires), remaining: duration },
    };
    return row.s === "h" && row.h !== undefined
      ? { ...taken, takenOverFrom: { holderInstanceId: row.h, token: token - 1 } }
      : taken;
  }
}

/**
 * A cluster lease store whose Redis `acquire` reads the row, then writes it, beside the database's
 * row (D6): the order of the two writes is the core's, the broken part is the cluster's take.
 */
export class ReadThenWriteLeaseRepository extends ClusterExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    redis: RedisConnection,
    time: StoreClock,
    application: ApplicationContext,
    keptIds: ExecutionIdStore,
  ) {
    super(new ReadThenWriteCoordinator(redis, time, application), keptIds);
  }
}
