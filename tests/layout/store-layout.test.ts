/**
 * agbossjs/agboss#693 — the cross-backend decision, checked by the core's one-backend rule (#526)
 * on the public `createApp`: a Redis lease store with a fenced-effect or outbound-call store of
 * another backend (SQLite here; PostgreSQL and MongoDB declare theirs the same way) fails assembly
 * with `[application.store-backend-mismatch]`, and so does any of them with the default in-memory
 * leases next to the Redis queue. The write must check the lease in its own transaction (ADR-0026,
 * Guarantees A2) — a PostgreSQL transaction cannot see a Redis lease taken over meanwhile — so the
 * rule is not weakened here. The layouts Redis supports assemble: Redis leases with no fencing
 * store listed; the Redis queue and rate limits beside a fencing set of another backend (no atomic
 * step spans them).
 */
import {
  createApp,
  GraphRuleError,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  type Class,
} from "@agboss/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisExecutionLeaseRepository,
  RedisRateLimitRepository,
} from "../../src/index.js";
import { layoutOf, LayoutRedisExecutionLeaseRepository } from "../fixtures/layout.application.js";
import { DURABLE_URL } from "../support/server.js";

beforeAll(() => {
  process.env.AGBOSS_LAYOUT_REDIS_URL = DURABLE_URL === "" ? "redis://127.0.0.1:1" : DURABLE_URL;
  process.env.AGBOSS_LAYOUT_REDIS_PREFIX = `agboss-layout:${String(process.pid)}:`;
  process.env.AGBOSS_LAYOUT_SQLITE_PATH = ":memory:";
  process.env.AGBOSS_LAYOUT_OPENROUTER_KEY = "unused-no-model-is-called";
});

/** The store-backend violations of assembling `providers`, as `[code] message`. */
async function backendViolationsOf(providers: readonly Class[]): Promise<readonly string[]> {
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

const LEASES = "LayoutRedisExecutionLeaseRepository";

const mismatch = (
  fencing: string,
  backend: string,
  leases: string,
  leaseBackend: string,
): unknown =>
  expect.stringMatching(
    new RegExp(
      `^\\[application\\.store-backend-mismatch\\] ${fencing} \\(backend "${backend}"\\) .*${leases} \\(backend "${leaseBackend}"\\)`,
      "u",
    ),
  );

describe("agbossjs/agboss#693: Redis leases with a fencing store of another backend fail assembly", () => {
  it("the Redis lease store declares its own backend, its subclasses inherit it", () => {
    expect(RedisExecutionLeaseRepository.store.backend).toBe("redis");
    expect(LayoutRedisExecutionLeaseRepository.store.backend).toBe("redis");
  });

  it.each([
    [SqliteFencedEffectRepository, "SqliteFencedEffectRepository"],
    [SqliteOutboundCallRepository, "SqliteOutboundCallRepository"],
  ] as const)("Redis leases with %o → store-backend-mismatch", async (store, name) => {
    expect(
      await backendViolationsOf([
        RedisConnection,
        SqliteConnection,
        LayoutRedisExecutionLeaseRepository,
        store,
      ]),
    ).toEqual([mismatch(name, "sqlite", LEASES, "redis")]);
  });

  it("both, at once: each named", async () => {
    const violations = await backendViolationsOf([
      ...[RedisConnection, SqliteConnection, LayoutRedisExecutionLeaseRepository],
      ...[SqliteFencedEffectRepository, SqliteOutboundCallRepository],
    ]);
    expect(violations).toHaveLength(2);
  });
});

describe.skipIf(DURABLE_URL === "")(
  "agbossjs/agboss#693: the layouts Redis supports assemble",
  () => {
    it("Redis leases, queue and rate limits, no fencing store listed", async () => {
      expect(
        await backendViolationsOf([
          ...[RedisConnection, LayoutRedisExecutionLeaseRepository],
          ...[RedisChildExecutionQueueRepository, RedisRateLimitRepository],
        ]),
      ).toEqual([]);
    });

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
