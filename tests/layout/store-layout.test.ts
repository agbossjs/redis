/**
 * agbossjs/agboss#693 — the layouts of the Redis stores, checked on the public `createApp`. Under
 * the 0.1.1 cluster lease (D6) the fenced stores check the database's lease row (the store under
 * `EXECUTION_ID_STORE`), not Redis: a SQLite fencing set beside Redis leases is no
 * `[application.store-backend-mismatch]` — Redis only decides liveness. The layouts assemble:
 * Redis leases with no fencing store listed; with a SQLite fencing set; the Redis queue and rate
 * limits beside a fencing set of another backend (no atomic step spans them). A cross-backend
 * mismatch of the database's own lease and fencing stores is the core's rule, tested there.
 */
import {
  createApp,
  ExecutionLeaseRepository,
  GraphRuleError,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  type Provider,
} from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  REDIS_COORDINATION_STORES,
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisExecutionLeaseRepository,
  RedisRateLimitRepository,
} from "../../src/index.js";
import { LAYOUT_EXECUTION_IDS, layoutOf } from "../fixtures/layout.application.js";
import { DURABLE_URL } from "../support/server.js";

beforeAll(() => {
  process.env.AGBOSS_LAYOUT_REDIS_URL = DURABLE_URL === "" ? "redis://127.0.0.1:1" : DURABLE_URL;
  process.env.AGBOSS_LAYOUT_REDIS_PREFIX = `agboss-layout:${String(process.pid)}:`;
  process.env.AGBOSS_LAYOUT_SQLITE_PATH = ":memory:";
  process.env.AGBOSS_LAYOUT_OPENROUTER_KEY = "unused-no-model-is-called";
});

/** The store-backend violations of assembling `providers`, as `[code] message`. */
async function backendViolationsOf(providers: readonly Provider[]): Promise<readonly string[]> {
  const error: unknown = await createApp(layoutOf(providers), { env: "layout" }).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return [];
  if (error instanceof Error && !(error instanceof GraphRuleError)) throw error;
  if (!(error instanceof GraphRuleError)) throw new Error("the assembly threw a non-error");
  return error.violations
    .filter((found) => found.code.startsWith("application.store-backend"))
    .map((found) => `[${found.code}] ${found.message}`);
}

describe("agbossjs/agboss#693: the Redis lease store's backend", () => {
  it("the Redis lease store declares its own backend", () => {
    expect(RedisExecutionLeaseRepository.store.backend).toBe("redis");
  });
});

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#693: the layouts Redis supports assemble",
  () => {
    it("Redis leases, queue and rate limits, no fencing store listed", async () => {
      expect(
        await backendViolationsOf([
          ...[RedisConnection, RedisExecutionLeaseRepository, LAYOUT_EXECUTION_IDS],
          ...[RedisChildExecutionQueueRepository, RedisRateLimitRepository],
        ]),
      ).toEqual([]);
    });

    it.each([[SqliteFencedEffectRepository], [SqliteOutboundCallRepository]] as const)(
      "agbossjs/agboss#1321e D6: Redis leases with %o, the ids under EXECUTION_ID_STORE: the fence is the database's row, no mismatch",
      async (store) => {
        expect(
          await backendViolationsOf([
            ...[RedisConnection, SqliteConnection, RedisExecutionLeaseRepository],
            ...[LAYOUT_EXECUTION_IDS, store],
          ]),
        ).toEqual([]);
      },
    );

    it("the Redis queue and rate limits beside a SQLite fencing set: not constrained", async () => {
      expect(
        await backendViolationsOf([
          ...[RedisConnection, RedisChildExecutionQueueRepository, RedisRateLimitRepository],
          ...[SqliteConnection, SqliteExecutionLeaseRepository],
          ...[SqliteFencedEffectRepository, SqliteOutboundCallRepository],
        ]),
      ).toEqual([]);
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
    it("AC2: provide(EXECUTION_ID_STORE, SqliteExecutionLeaseRepository) — no [di.ambiguous-implementation], no new, the ids kept there", async () => {
      const app = await createApp(
        layoutOf([RedisConnection, RedisExecutionLeaseRepository, LAYOUT_EXECUTION_IDS]),
        { env: "layout" },
      );
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

    it("AC3: ...REDIS_COORDINATION_STORES assembles beside the ids' durable store", async () => {
      expect(REDIS_COORDINATION_STORES).toEqual([
        RedisExecutionLeaseRepository,
        RedisChildExecutionQueueRepository,
        RedisRateLimitRepository,
      ]);
      const app = await createApp(
        layoutOf([RedisConnection, ...REDIS_COORDINATION_STORES, LAYOUT_EXECUTION_IDS]),
        { env: "layout" },
      );
      try {
        expect(app.resolve(ExecutionLeaseRepository)).toBeInstanceOf(RedisExecutionLeaseRepository);
      } finally {
        await app.close();
      }
    });
  },
);
