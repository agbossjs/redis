import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteExecutionLeaseRepository,
  StoreClock,
  StoreTimeSource,
  type ExecutionLeaseRepository,
} from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import type { ContractTarget, StoreInstanceContext } from "@agboss/core/testing/contracts";
import { RedisConnection, RedisExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "./application-context.js";
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
  /** The file's durable lease store: new after every `reset`. */
  readonly keptIds: SharedKeptIds;
  /** The connections no store holds now, lent again to the next instance. */
  readonly idle: RedisConnection[];
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The application's durable lease store of the tests (`EXECUTION_ID_STORE`, #591, #891): the core's
 * SQLite lease store on a file of its own, so every instance of the file's tests shares one set of
 * rows — the execution ids, the cancel, stop and pause marks and their fence, the mirror of the
 * cluster's leases (D6) — as PostgreSQL's would give, and never Redis (#527). The real store, so
 * the order of the two writes is tested against the semantics of a database, not a double of them.
 */
export class SharedKeptIds extends SqliteExecutionLeaseRepository {
  readonly #folder: string;

  constructor() {
    const folder = mkdtempSync(join(tmpdir(), "agboss-redis-durable-"));
    const application = new TestApplicationContext("durable");
    super(
      new SqliteConnection({ kind: "sqlite", path: join(folder, "durable.sqlite") }),
      new StoreClock(StoreTimeSource.Test),
      application,
    );
    this.#folder = folder;
  }

  /** Closes the file and removes it. */
  close(): void {
    this.connection.onDestroy();
    rmSync(this.#folder, { recursive: true, force: true });
  }
}

/** Every key under `prefix` removed (SCAN + UNLINK). */
async function removeKeys(connection: RedisConnection, prefix: string): Promise<void> {
  for await (const keys of connection.native.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 }))
    if (keys.length > 0) await connection.native.unlink(keys);
}

/** A key space of its own for one test file, on the durable test server. */
export function testKeySpace(name: string): TestKeySpace {
  const prefix = `agboss-test:${name}:${randomUUID()}:`;
  let keptIds = new SharedKeptIds();
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
    get keptIds() {
      return keptIds;
    },
    idle,
    reset: async () => {
      keptIds.close();
      keptIds = new SharedKeptIds();
      await removeKeys(await adminOf(), prefix);
    },
    close: async () => {
      keptIds.close();
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
  new RedisExecutionLeaseRepository(connection, seam.storeClock, seam.application, space.keptIds);
