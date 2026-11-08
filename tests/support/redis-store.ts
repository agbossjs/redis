import { randomUUID } from "node:crypto";
import { type ExecutionIdentity, type ExecutionLeaseRepository } from "@agboss/core";
import type { ContractTarget, StoreInstanceContext } from "@agboss/core/testing/contracts";
import { RedisConnection, RedisExecutionLeaseRepository } from "../../src/index.js";
import type { KeptExecutionIds } from "../../src/index.js";
import { DURABLE_URL } from "./server.js";

/**
 * The Redis stores as entries of the core's `storeConformance` (agbossjs/agboss#526): each
 * instance on a connection of its own — two application instances on one server, as two pods are
 * — under a key prefix of the test file's own, so files running side by side never see each other's
 * keys. The set's `reset` removes every key of that prefix (and the kept ids) before each case.
 */

/** A key space of one test file: its prefix, its kept ids, and how to empty both. */
export interface TestKeySpace {
  readonly prefix: string;
  readonly keptIds: SharedKeptIds;
  /** The connections no store holds now, lent again to the next instance. */
  readonly idle: RedisConnection[];
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The kept execution ids of the tests: shared by every instance of the file, as the application's
 * durable lease store keeps them (#591) — never in Redis (#527). One insert-if-absent by the id.
 */
export class SharedKeptIds implements KeptExecutionIds {
  readonly ids = new Map<string, string>();

  claimExecutionId({ executionId, tenantId }: ExecutionIdentity): Promise<boolean> {
    if (this.ids.has(executionId)) return Promise.resolve(false);
    this.ids.set(executionId, tenantId);
    return Promise.resolve(true);
  }
}

/** The lease store of the tests: Redis leases, the kept ids in `SharedKeptIds`. */
export class TestRedisExecutionLeaseRepository extends RedisExecutionLeaseRepository {}

/** Every key under `prefix` removed (SCAN + UNLINK). */
async function removeKeys(connection: RedisConnection, prefix: string): Promise<void> {
  for await (const keys of connection.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 }))
    if (keys.length > 0) await connection.client.unlink(keys);
}

/** A key space of its own for one test file, on the durable test server. */
export function testKeySpace(name: string): TestKeySpace {
  const prefix = `agboss-test:${name}:${randomUUID()}:`;
  const keptIds = new SharedKeptIds();
  let admin: RedisConnection | undefined;
  const adminOf = async (): Promise<RedisConnection> => {
    if (admin !== undefined) return admin;
    admin = new RedisConnection({ url: DURABLE_URL, keyPrefix: prefix });
    await admin.onInit();
    return admin;
  };
  const idle: RedisConnection[] = [];
  return {
    prefix,
    keptIds,
    idle,
    reset: async () => {
      keptIds.ids.clear();
      await removeKeys(await adminOf(), prefix);
    },
    close: async () => {
      for (const connection of idle.splice(0)) await connection.onDestroy();
      if (admin === undefined) return;
      await removeKeys(admin, prefix);
      await admin.onDestroy();
    },
  };
}

/** A connection of `space`, started (its checks run). */
export async function connectionOf(space: TestKeySpace): Promise<RedisConnection> {
  const connection = new RedisConnection({ url: DURABLE_URL, keyPrefix: space.prefix });
  await connection.onInit();
  return connection;
}

/**
 * One store of `space` per instance. The explorer opens thousands of schedules, two or three
 * instances each: a connection is lent from the file's pool and given back when its store closes
 * (each instance still has a connection of its own), all of them closed with the key space.
 */
export function redisStore<TStore extends object>(
  space: TestKeySpace,
  make: (connection: RedisConnection, seam: StoreInstanceContext) => TStore,
): Omit<ContractTarget<TStore>, "name"> {
  const lent = new WeakMap<TStore, RedisConnection>();
  return {
    instance: async (seam) => {
      const connection = space.idle.pop() ?? (await connectionOf(space));
      const store = make(connection, seam);
      lent.set(store, connection);
      return store;
    },
    close: (store) => {
      const connection = lent.get(store);
      lent.delete(store);
      if (connection !== undefined) space.idle.push(connection);
    },
  };
}

/** The lease store of `space` for one instance. */
export const leasesOf = (
  space: TestKeySpace,
  connection: RedisConnection,
  seam: StoreInstanceContext,
): ExecutionLeaseRepository =>
  new TestRedisExecutionLeaseRepository(
    connection,
    seam.storeClock,
    seam.application,
    space.keptIds,
  );
