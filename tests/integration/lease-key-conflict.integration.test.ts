/**
 * agbossjs/agboss#923 — the Redis lease store and the id store it asks (`EXECUTION_ID_STORE`) belong
 * to one deployment. A database emptied or replaced under a Redis that was not (ids start again at
 * `execution-1`, the lease keys of the old executions stay — a retired one is never taken again) used
 * to leave every take of the new execution refused for good, retried for ever. Now the claim of an id
 * the id store hands out as new fails when its lease key already exists.
 */
import { seconds } from "@agboss/core/units";
import { afterAll, describe, expect, it } from "vitest";
import { RedisExecutionLeaseRepository, RedisLeaseKeyConflictError } from "../../src/index.js";
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionOf, SharedKeptIds, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const LEASE = seconds(30);
const identity = { tenantId: "default", executionId: "execution-1" };

describe.skipIf(DURABLE_URL === "")("agbossjs/agboss#923: a lease key of another database", () => {
  const space = testKeySpace("lease-key-conflict");
  afterAll(async () => {
    await space.close();
  });

  /** A lease store on this file's Redis whose id store is `ids` (one database's). */
  const storeOf = async (ids: SharedKeptIds): Promise<RedisExecutionLeaseRepository> => {
    const connection = await connectionOf(space);
    space.idle.push(connection);
    const clock = new StoreClock(StoreTimeSource.Database, { now: () => new Date() });
    return new RedisExecutionLeaseRepository(
      connection,
      clock,
      new TestApplicationContext({}),
      ids,
    );
  };

  it("AC2: an id the id store hands out as new, whose lease key exists, fails — it is not taken for ever", async () => {
    await space.reset();
    const old = await storeOf(new SharedKeptIds());
    expect(await old.claimExecutionId(identity)).toBe(true);
    const lease = await old.acquire(identity.tenantId, identity.executionId, LEASE);
    if (lease === undefined) throw new Error("a new tree is taken");
    await old.retire(lease);

    const fresh = await storeOf(new SharedKeptIds());

    const refused = await fresh.claimExecutionId(identity).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RedisLeaseKeyConflictError);
    expect(refused).toMatchObject({ code: "redis.lease-key-conflict", ...identity });
    expect(String(refused)).toContain("redisKeyPrefix");
    expect(await fresh.acquire(identity.tenantId, identity.executionId, LEASE)).toBeUndefined();
  });

  it("an id the id store already had is `false` as before, whatever its lease key", async () => {
    await space.reset();
    const store = await storeOf(new SharedKeptIds());
    expect(await store.claimExecutionId(identity)).toBe(true);
    expect(await store.acquire(identity.tenantId, identity.executionId, LEASE)).toBeDefined();

    expect(await store.claimExecutionId(identity)).toBe(false);
  });

  it("a new id with no lease key is claimed and taken as ever", async () => {
    await space.reset();
    const store = await storeOf(new SharedKeptIds());

    expect(await store.claimExecutionId(identity)).toBe(true);
    expect((await store.acquire(identity.tenantId, identity.executionId, LEASE))?.token).toBe(1);
  });
});
