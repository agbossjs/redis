import type { DatabaseSync } from "node:sqlite";
import {
  env,
  secret,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
  type Secret,
} from "@agboss/core";
import type { FaultStores } from "@agboss/core/testing/faults";
import {
  RedisChildExecutionQueueRepository,
  RedisConnection,
  RedisRateLimitRepository,
} from "../../src/index.js";

/**
 * agbossjs/agboss#693 AC2 — the Redis coordination stores under the core's fault suite, beside a
 * durable fencing set: every pod imports this module (outside vitest) and lists the Redis child
 * queue and rate limits (the tree slots of the fixture's `AnyInstance` children) on the test's
 * Redis, under a key prefix of the scenario's own (`AGBOSS_FAULT_REDIS_PREFIX`, set by the
 * target's reset before the pods start), and the core's SQLite stores — leases, fenced effects,
 * outbound calls, the lease log, records, trees, history, pauses, checkpoints — on the scenario's
 * file (`AGBOSS_FAULT_DATABASE_URL`, cut by the suite's store outages). The fencing stores stay on
 * one transactional backend with their leases (#526): a Redis lease store cannot back the
 * fixture's fenced charge, and is explored by `storeConformance` and the crash test instead.
 */

/** The table of the fixture's business rows. */
const BUSINESS_ROWS = "CREATE TABLE IF NOT EXISTS fault_business_rows (row TEXT NOT NULL)";

/** The environment the stores read: the scenario's file and the test's Redis. */
export class RedisFaultEnvironment {
  sqlitePath!: string;
  redisUrl!: Secret;
  redisKeyPrefix?: string;
}

export const faultStores: FaultStores<DatabaseSync> = {
  providers: [
    SqliteConnection,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionHistoryRepository,
    SqliteExecutionLeaseEventRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqliteExecutionTreeRepository,
    SqliteFencedEffectRepository,
    SqliteOutboundCallRepository,
    SqlitePausedExecutionRepository,
    RedisConnection,
    RedisChildExecutionQueueRepository,
    RedisRateLimitRepository,
  ],
  environment: {
    contract: RedisFaultEnvironment,
    values: {
      sqlitePath: env("AGBOSS_FAULT_DATABASE_URL"),
      redisUrl: secret("AGBOSS_FAULT_REDIS_URL"),
      redisKeyPrefix: env("AGBOSS_FAULT_REDIS_PREFIX"),
    },
  },
  businessRows: {
    insert: (database, row) => {
      database.exec(BUSINESS_ROWS);
      database.prepare("INSERT INTO fault_business_rows (row) VALUES (?)").run(row);
    },
    committed: (app) => {
      const { database } = app.resolve(SqliteConnection);
      database.exec(BUSINESS_ROWS);
      const rows = database.prepare("SELECT row FROM fault_business_rows ORDER BY rowid").all();
      return Promise.resolve(rows.map((found) => String(found.row)));
    },
  },
};
