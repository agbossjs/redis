import {
  env,
  Injectable,
  secret,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionAuditLogRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
  type Secret,
} from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import { FaultStoreTime, type FaultStoreSet } from "@agboss/core/testing/faults";
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
 * outbound calls, the audit log, records, trees, history, pauses, checkpoints — on the scenario's
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

/**
 * The pod's SQLite connection, kept for the fixture's charge: it writes its business row in the
 * fenced effect's ambient transaction (#1317c), which `SqliteConnection.requireTransaction()`
 * gives. Listed beside the stores, so the container makes it with them.
 */
let businessConnection: SqliteConnection | undefined;

@Injectable({ deps: [SqliteConnection] })
export class FaultBusinessConnection {
  constructor(connection: SqliteConnection) {
    businessConnection = connection;
  }
}

export const faultStores: FaultStoreSet = {
  // agbossjs/agboss#799: the fencing stores the history records are SQLite's, on the pods' clock —
  // read at the suite's timeScale (the Redis queue and rate limits are not in the checked model)
  storeTime: FaultStoreTime.Host,
  providers: [
    SqliteConnection,
    FaultBusinessConnection,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionHistoryRepository,
    SqliteExecutionAuditLogRepository,
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
    // the effect's ambient transaction (#1317c)
    insert: (row) => {
      if (businessConnection === undefined)
        throw new Error("the fault set's business connection was not made");
      const transaction = businessConnection.requireTransaction();
      transaction.exec(BUSINESS_ROWS);
      transaction.prepare("INSERT INTO fault_business_rows (row) VALUES (?)").run(row);
    },
    committed: (app) => {
      const { database } = app.resolve(SqliteConnection);
      database.exec(BUSINESS_ROWS);
      const rows = database.prepare("SELECT row FROM fault_business_rows ORDER BY rowid").all();
      return Promise.resolve(rows.map((found) => String(found.row)));
    },
  },
};
