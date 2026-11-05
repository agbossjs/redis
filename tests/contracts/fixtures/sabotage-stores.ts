import { StoreClock, type ApplicationContext, type Clock, type ExecutionLease } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import type { RedisConnection } from "../../../src/index.js";
import type { KeptExecutionIds } from "../../../src/index.js";
import { keyOf } from "../../../src/connection/scripts.js";
import { TestRedisExecutionLeaseRepository } from "../../support/redis-store.js";

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
export class CallerStoreClock extends StoreClock {
  readonly isDatabaseTime = false;

  constructor(private readonly clock: Clock) {
    super();
  }

  now(): Date {
    return this.clock.now();
  }
}

/** A lease store whose `acquire` reads the row, then writes it: check-then-write. */
export class ReadThenWriteLeaseRepository extends TestRedisExecutionLeaseRepository {
  constructor(
    private readonly redis: RedisConnection,
    private readonly time: StoreClock,
    private readonly application: ApplicationContext,
    keptIds: KeptExecutionIds,
  ) {
    super(redis, time, application, keptIds);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = keyOf(this.redis.keyPrefix, "lease", tenantId, rootExecutionId);
    const row = await this.redis.client.hGetAll(key);
    const now = this.time.now().getTime();
    if (row.s === "f" || (row.s === "h" && Number(row.x) > now)) return undefined;
    const leaseEpoch = Number(row.e ?? "0") + 1;
    const expires = now + lease;
    const holderInstanceId = this.application.instanceId;
    await this.redis.client.hSet(key, {
      ...{ h: holderInstanceId, e: String(leaseEpoch), x: String(expires) },
      ...{ s: "h", y: "0" },
    });
    const taken = {
      ...{ tenantId, rootExecutionId, holderInstanceId, leaseEpoch },
      ...{ expiresAt: new Date(expires), remaining: lease },
    };
    return row.s === "h" && row.h !== undefined
      ? { ...taken, takenOverFrom: { holderInstanceId: row.h, leaseEpoch: leaseEpoch - 1 } }
      : taken;
  }
}
