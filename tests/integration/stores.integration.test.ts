/**
 * agbossjs/agboss#693 — what the contract suites cannot see, on the real server: a lease's expiry is
 * the server's own `TIME` in production (agbossjs/agboss#533 clock authority — a store clock whose
 * `now()` is decades off changes nothing), a lease key never expires and its epoch never starts
 * over, a script dropped from the server's cache (`SCRIPT FLUSH`, a restart) runs again from its
 * source, the rate-limit keys expire by themselves, and the start checks pass on one durable
 * primary.
 */
import { StoreClock } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { afterAll, describe, expect, it } from "vitest";
import { RedisRateLimitRepository } from "../../src/index.js";
import { keyOf } from "../../src/connection/scripts.js";
import { TestApplicationContext } from "../support/application-context.js";
import {
  connectionOf,
  testKeySpace,
  TestRedisExecutionLeaseRepository,
} from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

/** The production store clock, whose own `now()` a store must never read for a lease. */
class DecadesOffStoreClock extends StoreClock {
  readonly isDatabaseTime = true;
  now(): Date {
    return new Date("2001-01-01T00:00:00.000Z");
  }
}

const LEASE = seconds(30);

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#693: the Redis stores on the real server",
  () => {
    const space = testKeySpace("stores");

    afterAll(async () => {
      await space.close();
    });

    const leasesOf = async (instanceId = "instance-1") => {
      const connection = await connectionOf(space);
      space.idle.push(connection);
      return {
        connection,
        leases: new TestRedisExecutionLeaseRepository(
          connection,
          new DecadesOffStoreClock(),
          new TestApplicationContext({}, instanceId),
          space.keptIds,
        ),
      };
    };

    const serverMs = async (
      connection: Awaited<ReturnType<typeof connectionOf>>,
    ): Promise<number> => {
      const [unixSeconds, microseconds] = await connection.client.time();
      return Number(unixSeconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    };

    it("#533: the expiry is the server's TIME inside the script, never the store clock's now()", async () => {
      const { connection, leases } = await leasesOf();
      const before = await serverMs(connection);
      const lease = await leases.acquire("default", "clock-1", LEASE);
      const after = await serverMs(connection);

      expect(lease?.remaining).toBe(LEASE);
      expect(lease?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE);
      expect(lease?.expiresAt.getTime()).toBeLessThanOrEqual(after + LEASE + 1);
      const renewed = lease === undefined ? undefined : await leases.renew(lease, LEASE);
      expect(renewed).toBe(LEASE);
    });

    it("a lease key never expires and its epoch counts on after a release and a finish", async () => {
      const { connection, leases } = await leasesOf();
      const key = keyOf(space.prefix, "lease", "default", "epochs-1");
      const first = await leases.acquire("default", "epochs-1", LEASE);
      if (first === undefined) throw new Error("a free tree is taken");
      await leases.release(first);
      const second = await leases.acquire("default", "epochs-1", LEASE);
      if (second === undefined) throw new Error("a released tree is taken again");
      await leases.finish(second);

      expect(await connection.client.pTTL(key)).toBe(-1);
      expect(second.leaseEpoch).toBe(2);
      expect(await leases.acquire("default", "epochs-1", LEASE)).toBeUndefined();
      expect(await connection.client.hGet(key, "e")).toBe("2");
    });

    it("a script dropped from the server's cache runs again from its source, once", async () => {
      const { connection, leases } = await leasesOf();
      await connection.client.scriptFlush();
      const lease = await leases.acquire("default", "flushed-1", LEASE);

      expect(lease?.leaseEpoch).toBe(1);
      expect(await leases.acquire("default", "flushed-1", LEASE)).toBeUndefined();
    });

    it("the rate-limit keys expire by themselves once nothing in them matters", async () => {
      const connection = await connectionOf(space);
      space.idle.push(connection);
      const clock = {
        now: () => new Date(),
        sleep: () => Promise.resolve(),
        monotonicNow: () => 0,
      };
      const limits = new RedisRateLimitRepository(
        connection,
        clock,
        new TestApplicationContext({}),
      );
      await limits.acquire("provider-1", 2, seconds(10));
      await limits.addToWindow("provider-1", 3, seconds(60));
      await limits.pauseUntil("provider-1", new Date(Date.now() + 5_000));

      for (const kind of ["slots", "window", "window-amounts", "pause"]) {
        const ttl = await connection.client.pTTL(
          keyOf(space.prefix, `rate-limit-${kind}`, "provider-1"),
        );
        expect(ttl).toBeGreaterThan(0);
      }
    });

    it("the start checks pass on one durable primary", async () => {
      const connection = await connectionOf(space);
      space.idle.push(connection);

      await expect(connection.deployment()).resolves.toBeUndefined();
      expect(await connection.durability()).toEqual({ problems: [], optedOut: false });
    });
  },
);
