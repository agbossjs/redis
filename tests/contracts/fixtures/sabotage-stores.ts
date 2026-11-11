import {
  type ExecutionIdStore,
  StoreClock,
  StoreTimeSource,
  type ApplicationContext,
  type Clock,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { RedisExecutionLeaseRepository, type RedisConnection } from "../../../src/index.js";
import { keyOf } from "../../../src/connection/scripts.js";

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

/** A lease store whose `acquire` reads the row, then writes it: check-then-write. */
export class ReadThenWriteLeaseRepository extends RedisExecutionLeaseRepository {
  constructor(
    private readonly redis: RedisConnection,
    private readonly time: StoreClock,
    private readonly application: ApplicationContext,
    keptIds: ExecutionIdStore,
  ) {
    super(redis, time, application, keptIds);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const key = keyOf(this.redis.keyPrefix, "lease", tenantId, rootExecutionId);
    const row = await this.redis.client.hGetAll(key);
    const now = this.time.now().getTime();
    if (row.s === "f" || (row.s === "h" && Number(row.x) > now)) return undefined;
    const token = Number(row.e ?? "0") + 1;
    const expires = now + duration;
    const holderInstanceId = this.application.instanceId;
    await this.redis.client.hSet(key, {
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
