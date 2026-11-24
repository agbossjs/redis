/**
 * agbossjs/agboss#1117 and #1152 on Redis — a tree's cancel mark is permanent and is read by the
 * sweep, so it lives in the durable store under `EXECUTION_ID_STORE` (its lease row in PostgreSQL or
 * MongoDB), as the kept execution ids do, never in Redis. Proved at the server: the cancel writes the
 * cache of the marks only (D6: one key, pushed after the row, never read back), and a Redis emptied under the application (`FLUSHDB` on a database index of this file's own —
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
    const durables: SharedKeptIds[] = [];
    const durableOf = (): SharedKeptIds => {
      const durable = new SharedKeptIds();
      durables.push(durable);
      return durable;
    };
    afterAll(async () => {
      for (const durable of durables) durable.close();
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

    it("a cancel is kept by the durable store; Redis gets only the cache of the marks (one key) and never reads it back", async () => {
      const connection = await connect();
      await connection.native.flushDb();
      const durable = durableOf();
      const store = storeOf(connection, durable);
      const held = await store.acquire("default", "execution-1", LEASE);
      const before = await connection.native.dbSize();

      await store.requestCancel(TREE);
      await store.requestCancel(TREE);

      expect(held).toMatchObject({ token: 1 });
      // the marks' cache: one hash, however often the mark is pushed
      expect(await connection.native.dbSize()).toBe(before + 1);
      expect(await durable.isCancelRequested(TREE)).toBe(true);
      expect(await store.isCancelRequested(TREE)).toBe(true);
      expect(await store.isCancelRequested(OTHER)).toBe(false);
    });

    it("a Redis emptied under the application keeps the mark, and the cancel before an acquire still gives token 1", async () => {
      const connection = await connect();
      await connection.native.flushDb();
      const durable = durableOf();
      const store = storeOf(connection, durable);
      await store.requestCancel(OTHER);
      expect(await store.acquire("default", "execution-2", LEASE)).toMatchObject({ token: 1 });
      expect(await store.acquire("default", "execution-1", LEASE)).toMatchObject({ token: 1 });
      await store.requestCancel(TREE);

      await connection.native.flushDb();

      expect(await connection.native.dbSize()).toBe(0);
      expect(await store.isCancelRequested(TREE)).toBe(true);
      expect(await store.isCancelRequested(OTHER)).toBe(true);
      expect(await storeOf(connection, durable).isCancelRequested(TREE)).toBe(true);
      expect(
        await store.isCancelRequested({ tenantId: "acme", rootExecutionId: "execution-1" }),
      ).toBe(false);
    });
  },
);
