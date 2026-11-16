/**
 * agbossjs/agboss#1117 and #1152 on Redis — a tree's cancel mark is permanent and is read by the
 * sweep, so it lives in the durable store under `EXECUTION_ID_STORE` (its lease row in PostgreSQL or
 * MongoDB), as the kept execution ids do, never in Redis. Proved at the server: the cancel writes no
 * key, and a Redis emptied under the application (`FLUSHDB` on a database index of this file's own —
 * `FLUSHALL` would empty the other test files' keys on the same server) still answers that the cancel
 * was requested. A store that wrote its mark only to Redis would lose it there.
 */
import { StoreClock, StoreTimeSource, type ExecutionIdStore } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { afterAll, describe, expect, it } from "vitest";
import { RedisConnection, RedisExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { SharedKeptIds, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const LEASE = seconds(30);
const TREE = { tenantId: "default", rootExecutionId: "execution-1" } as const;
const OTHER = { tenantId: "default", rootExecutionId: "execution-2" } as const;
/** A database index of this file's own on the durable server. */
const OWN_DATABASE = `${DURABLE_URL}/11`;

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#1152: the cancel mark is kept by the durable store, not Redis",
  () => {
    const space = testKeySpace("cancel-mark-durable");
    const opened: RedisConnection[] = [];
    afterAll(async () => {
      for (const connection of opened) await connection.onDestroy();
      await space.close();
    });

    const connect = async (): Promise<RedisConnection> => {
      const connection = new RedisConnection({ url: OWN_DATABASE, keyPrefix: space.prefix });
      await connection.onInit();
      opened.push(connection);
      return connection;
    };

    const storeOf = (
      connection: RedisConnection,
      durable: ExecutionIdStore,
    ): RedisExecutionLeaseRepository =>
      new RedisExecutionLeaseRepository(
        connection,
        new StoreClock(StoreTimeSource.Database, { now: () => new Date() }),
        new TestApplicationContext({}),
        durable,
      );

    it("a cancel writes no key to Redis and is kept by the durable store", async () => {
      const connection = await connect();
      await connection.client.flushDb();
      const durable = new SharedKeptIds();
      const store = storeOf(connection, durable);
      const held = await store.acquire("default", "execution-1", LEASE);
      const before = await connection.client.dbSize();

      await store.requestCancel(TREE);
      await store.requestCancel(TREE);

      expect(held).toMatchObject({ token: 1 });
      expect(await connection.client.dbSize()).toBe(before);
      expect(durable.cancels.size).toBe(1);
      expect(await store.isCancelRequested(TREE)).toBe(true);
      expect(await store.isCancelRequested(OTHER)).toBe(false);
    });

    it("a Redis emptied under the application keeps the mark, and the cancel before an acquire still gives token 1", async () => {
      const connection = await connect();
      await connection.client.flushDb();
      const durable = new SharedKeptIds();
      const store = storeOf(connection, durable);
      await store.requestCancel(OTHER);
      expect(await store.acquire("default", "execution-2", LEASE)).toMatchObject({ token: 1 });
      expect(await store.acquire("default", "execution-1", LEASE)).toMatchObject({ token: 1 });
      await store.requestCancel(TREE);

      await connection.client.flushDb();

      expect(await connection.client.dbSize()).toBe(0);
      expect(await store.isCancelRequested(TREE)).toBe(true);
      expect(await store.isCancelRequested(OTHER)).toBe(true);
      expect(await storeOf(connection, durable).isCancelRequested(TREE)).toBe(true);
      expect(
        await store.isCancelRequested({ tenantId: "acme", rootExecutionId: "execution-1" }),
      ).toBe(false);
    });

    it("a store under EXECUTION_ID_STORE that keeps ids only is refused at assembly, naming what it lacks", async () => {
      const connection = await connect();
      const idsOnly: ExecutionIdStore = { claimExecutionId: () => Promise.resolve(true) };

      expect(() => storeOf(connection, idsOnly)).toThrow(/durable lease store.*no requestCancel/u);
    });
  },
);
