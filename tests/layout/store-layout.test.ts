/**
 * agbossjs/agboss#693 — the layout of the Redis stores, checked on the public `createApp`. Under
 * the 0.1.1 cluster lease (D6) the fenced stores check the database's lease row (the store under
 * `EXECUTION_ID_STORE`), not Redis: a SQLite database beside Redis's cluster storage is no
 * `[application.store-backend-mismatch]` — Redis only decides liveness. Since agbossjs/agboss#1321
 * the stores are the storages' drivers' (a store class listed in `providers` beside a `storage` is
 * `[storage.providers-conflict]`), so the layout is the application's two storages, not a list of
 * classes. A cross-backend mismatch of the database's own lease and fencing stores is the core's
 * rule, tested there.
 */
import {
  createApp,
  ExecutionLeaseRepository,
  SqliteExecutionLeaseRepository,
  ConfigError,
} from "@agboss/core";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  REDIS_COORDINATION_STORES,
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisExecutionLeaseRepository,
  RedisRateLimitRepository,
} from "../../src/index.js";
import { LayoutApplication } from "../fixtures/layout.application.js";
import { DURABLE_URL } from "../support/server.js";

beforeAll(() => {
  process.env.AGBOSS_LAYOUT_REDIS_URL = DURABLE_URL === "" ? "redis://127.0.0.1:1" : DURABLE_URL;
  process.env.AGBOSS_LAYOUT_SQLITE_PATH = ":memory:";
});

/** The store-backend violations of assembling the layout application, as `[code] message`. */
async function backendViolationsOf(): Promise<readonly string[]> {
  const error: unknown = await createApp(LayoutApplication).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return [];
  if (error instanceof Error && !(error instanceof ConfigError.GraphRules)) throw error;
  if (!(error instanceof ConfigError.GraphRules)) throw new Error("the assembly threw a non-error");
  return error.violations
    .filter((found) => found.code.startsWith("application.store-backend"))
    .map((found) => `[${found.code}] ${found.message}`);
}

describe("agbossjs/agboss#693: the Redis stores' backend", () => {
  it("the Redis lease store declares its own backend", () => {
    expect(RedisExecutionLeaseRepository.store.backend).toBe("redis");
  });

  it("the connection and the coordination stores declare it too: a fault set's pod puts them on its cluster storage by it (#1324)", () => {
    for (const store of [
      RedisConnection,
      RedisChildExecutionQueueRepository,
      RedisRateLimitRepository,
    ])
      expect(store.store).toStrictEqual({ backend: "redis" });
  });
});

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#693: the layout Redis supports assembles",
  () => {
    it("Redis's cluster storage (leases, queue, rate limits) beside SQLite's database (the fencing stores, the ids): the fence is the database's row, no mismatch (#1321e D6)", async () => {
      expect(await backendViolationsOf()).toEqual([]);
    });
  },
);

describe("agbossjs/agboss#891 AC2: the Redis lease store is concrete, its ids under EXECUTION_ID_STORE", () => {
  it("AC2: the class is not abstract: the container can create it", () => {
    expectTypeOf(RedisExecutionLeaseRepository).toExtend<
      new (...args: never[]) => RedisExecutionLeaseRepository
    >();
    // its four deps: the connection, the store's clock, the application, EXECUTION_ID_STORE
    expect(RedisExecutionLeaseRepository.length).toBe(4);
  });
});

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#891 AC2/AC3: Redis leases on a real application's container",
  () => {
    it("AC2: the ids are kept by the database's lease store under EXECUTION_ID_STORE — no [di.ambiguous-implementation], no new", async () => {
      const app = await createApp(LayoutApplication);
      try {
        const leases = app.resolve(ExecutionLeaseRepository);
        const identity = { tenantId: "default", executionId: `ids-${String(process.pid)}` };

        expect(leases).toBeInstanceOf(RedisExecutionLeaseRepository);
        expect(await leases.claimExecutionId(identity)).toBe(true);
        expect(await leases.claimExecutionId(identity)).toBe(false);
        expect(await app.resolve(SqliteExecutionLeaseRepository).claimExecutionId(identity)).toBe(
          false,
        );
      } finally {
        await app.close();
      }
    });

    it("AC3: REDIS_COORDINATION_STORES is what the cluster storage provides", () => {
      expect(REDIS_COORDINATION_STORES).toEqual([
        RedisExecutionLeaseRepository,
        RedisChildExecutionQueueRepository,
        RedisRateLimitRepository,
      ]);
    });
  },
);
