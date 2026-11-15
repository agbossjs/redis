/**
 * agbossjs/agboss#909 and #1117 on Redis — the cancel mark is permanent and lives on the tree's
 * lease row, so that a backend's fencing stores read it in the transaction that checks the lease.
 * Redis keeps no fencing stores (A2 refuses a fenced write of another backend over its leases at
 * assembly), so `requestCancel` resolves and writes nothing: no seed key for a tree that was never
 * acquired, no field on a lease key, no key of a cancel request, and no lease changed. The core's
 * lease contract proves "changes no lease" through the store; this proves "writes nothing" at the
 * server, so a mark written here later is a decision, not a leftover.
 */
import { StoreClock, StoreTimeSource, type ExecutionLeaseRepository } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { afterAll, describe, expect, it } from "vitest";
import { RedisExecutionLeaseRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { connectionOf, SharedKeptIds, testKeySpace } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

const LEASE = seconds(30);
const TREE = { tenantId: "default", rootExecutionId: "execution-1" } as const;

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#1117: requestCancel on Redis writes nothing",
  () => {
    const space = testKeySpace("request-cancel-no-mark");
    afterAll(async () => {
      await space.close();
    });

    /** A lease store on this file's Redis; its id store is `ids`. */
    const storeOf = async (ids: SharedKeptIds): Promise<ExecutionLeaseRepository> => {
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

    /** Every key of this file's prefix with its dumped value: the whole state a cancel could touch. */
    const stateOf = async (): Promise<Map<string, string>> => {
      const connection = await connectionOf(space);
      space.idle.push(connection);
      const state = new Map<string, string>();
      for await (const keys of connection.client.scanIterator({
        MATCH: `${space.prefix}*`,
        COUNT: 500,
      }))
        for (const key of keys) {
          const dumped = await connection.client.dump(key);
          state.set(key, Buffer.from(dumped).toString("base64"));
        }
      return state;
    };

    it("a cancel before the first acquire leaves no seed key, and that acquire is token 1", async () => {
      await space.reset();
      const store = await storeOf(new SharedKeptIds());

      await store.requestCancel(TREE);
      await store.requestCancel(TREE);

      expect([...(await stateOf()).keys()]).toEqual([]);
      expect(await store.acquire("default", "execution-1", LEASE)).toMatchObject({ token: 1 });
    });

    it("a cancel of a held, a released and a retired lease changes no key of the server", async () => {
      await space.reset();
      const store = await storeOf(new SharedKeptIds());
      const held = await store.acquire("default", "execution-1", LEASE);
      if (held === undefined) throw new Error("the first acquire of a free tree must take it");

      const before = await stateOf();
      await store.requestCancel(TREE);
      const whileHeld = await stateOf();
      await store.release(held);
      const released = await stateOf();
      await store.requestCancel(TREE);
      const afterRelease = await stateOf();

      expect(before.size).toBeGreaterThan(0);
      // the held lease's own key moves only by the clock-free parts: compare what a cancel could add
      expect([...whileHeld.keys()].sort()).toEqual([...before.keys()].sort());
      expect(whileHeld).toEqual(before);
      expect(afterRelease).toEqual(released);
    });
  },
);
