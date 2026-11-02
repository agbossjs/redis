import { randomUUID } from "node:crypto";
import {
  ApplicationContext,
  Clock,
  Injectable,
  RateLimitRepository,
  type RateLimitLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import { RedisConnection } from "../connection/redis-connection.js";
import { keyOf, runScript, type RedisScript } from "../connection/scripts.js";
import { ADD_TO_WINDOW, PAUSE, RENEW_SLOT, TAKE_SLOT } from "./rate-limits/rate-limit-scripts.js";

/** How long a key outlives the last thing in it that can matter (a slot's or a pause's end). */
const KEPT_PAST_END: Milliseconds = 3_600_000 as Milliseconds;

const Total = z.string().transform(Number).pipe(z.number());

/**
 * `RateLimitRepository` on Redis (agbossjs/agboss#693): the slots of a key one sorted set (slot →
 * its end), a window its entries and amounts, a pause one string — every atomic operation one Lua
 * script (`rate-limits/rate-limit-scripts.ts`), so of two instances at the last free slot exactly
 * one takes it and a window's limit is never passed by two counts at once. Times are the framework
 * `Clock`'s (the contract; the core's A10: slots are not money). Each key expires an hour after
 * the last thing in it can matter. On any backend beside the leases (#526).
 */
@Injectable({ deps: [RedisConnection, Clock, ApplicationContext] })
export class RedisRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async acquire(
    key: string,
    maxSlots: number,
    lease: Milliseconds,
  ): Promise<RateLimitLease | undefined> {
    const now = this.clock.now().getTime();
    const slotId = randomUUID();
    const expiresAt = new Date(now + lease);
    const taken = await this.#run(
      TAKE_SLOT,
      [this.#key("slots", key)],
      [
        ...[slotId, String(maxSlots), String(expiresAt.getTime()), String(now)],
        String(lease + KEPT_PAST_END),
      ],
    );
    if (taken !== 1) return undefined;
    return { key, slotId, holderInstanceId: this.applicationContext.instanceId, expiresAt };
  }

  async renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const now = this.clock.now().getTime();
    const renewed = await this.#run(
      RENEW_SLOT,
      [this.#key("slots", rateLimitLease.key)],
      [...[rateLimitLease.slotId, String(now + lease), String(now)], String(lease + KEPT_PAST_END)],
    );
    return renewed === 1;
  }

  async release(rateLimitLease: RateLimitLease): Promise<void> {
    await this.connection.client.zRem(
      this.#key("slots", rateLimitLease.key),
      rateLimitLease.slotId,
    );
  }

  async addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    const now = this.clock.now().getTime();
    const total = await this.#run(
      ADD_TO_WINDOW,
      [this.#key("window", key), this.#key("window-amounts", key)],
      [
        ...[String(now), String(window), String(amount), limit === undefined ? "" : String(limit)],
        ...[randomUUID(), String(window + KEPT_PAST_END)],
      ],
    );
    return total === null ? undefined : Total.parse(total);
  }

  async clearWindow(key: string): Promise<void> {
    await this.connection.client.del([this.#key("window", key), this.#key("window-amounts", key)]);
  }

  async pauseUntil(key: string, until: Date): Promise<void> {
    const left = Math.max(0, until.getTime() - this.clock.now().getTime());
    await this.#run(
      PAUSE,
      [this.#key("pause", key)],
      [String(until.getTime()), String(left + KEPT_PAST_END)],
    );
  }

  async pausedUntil(key: string): Promise<Date | undefined> {
    const stored = await this.connection.client.get(this.#key("pause", key));
    if (stored === null) return undefined;
    const until = new Date(Number(stored));
    return until.getTime() > this.clock.now().getTime() ? until : undefined;
  }

  #key(kind: string, key: string): string {
    return keyOf(this.connection.keyPrefix, `rate-limit-${kind}`, key);
  }

  #run(script: RedisScript, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    return runScript(this.connection.client, script, keys, args);
  }
}
