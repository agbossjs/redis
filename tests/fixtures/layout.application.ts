import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
  ClusterStorage,
  DatabaseStorage,
  env,
  secret,
  SqliteDriver,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  onStart,
} from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { hours, usd, type Usd } from "@agboss/core/units";
import { RedisDriver } from "../../src/index.js";
import { StopBatchWorkflow, StopItemWorkflow } from "./stop/stop.application.js";

/**
 * agbossjs/agboss#693 — an application on Redis's cluster storage beside SQLite's database, for the
 * assembly checks of `tests/layout/store-layout.test.ts`: one workflow that answers its message as
 * it is (no model, no step); its Redis and its SQLite file are references its storages read from the
 * process when it starts.
 */

@WorkflowStart({
  name: "echo-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class EchoWorkflowStart {}

@WorkflowFinish({
  name: "echo-workflow-finish",
  description: "The message, as it came",
  output: WorkflowStartTextDto,
})
export class EchoWorkflowFinish {}

@Workflow({
  name: "echo-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(EchoWorkflowStart).toFinish(EchoWorkflowFinish)],
})
export class EchoWorkflow {}

@Budget({
  name: "layout-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class LayoutApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "layout-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class LayoutTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "layout-execution-budget", scope: BudgetScope.Execution })
export class LayoutExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

/** The prefix of the layout's keys: one per package run is enough, its executions' ids carry the process. */
export const LAYOUT_KEY_PREFIX = "agboss-layout:";

/**
 * SQLite keeps the rest, and the ids Redis's leases hand out: the database's lease store, which the
 * container binds under `EXECUTION_ID_STORE` (agbossjs/agboss#891, #1321), its row the authority.
 */
@DatabaseStorage({
  name: "layout-database-storage",
  description: "The layout tests' SQLite file",
  driver: SqliteDriver({ path: env("AGBOSS_LAYOUT_SQLITE_PATH") }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
})
export class LayoutDatabaseStorage {}

/** Redis coordinates: the leases, the child queue and the rate limits. */
@ClusterStorage({
  name: "layout-cluster-storage",
  description: "The layout tests' Redis",
  driver: RedisDriver({ url: secret("AGBOSS_LAYOUT_REDIS_URL"), keyPrefix: LAYOUT_KEY_PREFIX }),
})
export class LayoutClusterStorage {}

/** The application the layout tests assemble, and `npm run check:types` writes the flow types of. */
@Application({
  name: "layout-application",
  version: "1.0.0",
  storage: { database: LayoutDatabaseStorage, cluster: LayoutClusterStorage },
  workflows: [EchoWorkflow],
  budgets: [LayoutApplicationBudget, LayoutTenantBudget, LayoutExecutionBudget],
})
export class LayoutApplication {}

// `agboss check` types the workflows the application module exports (.agboss/types.d.ts), the stop
// tests' (`tests/fixtures/stop/`) included
export { StopBatchWorkflow, StopItemWorkflow };
