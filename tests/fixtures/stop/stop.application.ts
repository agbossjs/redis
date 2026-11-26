import {
  Action,
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  ChildPlacement,
  ClusterStorage,
  DatabaseStorage,
  ExecutionContext,
  env,
  listOf,
  onStart,
  secret,
  SqliteDriver,
  toWorkflow,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionHandler,
  type BudgetHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { Text } from "@agboss/core/dto";
import { hours, usd, type Usd } from "@agboss/core/units";
import { RedisDriver } from "../../../src/index.js";

/**
 * agbossjs/agboss#954 — an application of the stop tests: a recount whose items run as children on
 * any instance (so the child workers and the queue's watch run), each held at a gate the test
 * never opens; Redis keeps the leases, the queue and the rate limits, SQLite the rest.
 */

export class ItemDto {
  @Text({ prompt: "the item's name" })
  name!: string;
}

export class StopSummaryDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** The held steps: until the signal aborts they wait. */
@Action({
  name: "stop-hold-action",
  description: "Holds its step until the run is stopped",
  input: { item: ItemDto },
  output: ItemDto,
  deps: [ExecutionContext],
})
export class StopHoldAction implements ActionHandler<StopHoldAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<StopHoldAction>): Promise<OutputOf<StopHoldAction>> {
    const { signal } = this.executionContext;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error(`${input.item.name} stopped`));
      });
    });
  }
}

@WorkflowStart({ name: "stop-item-workflow-start", description: "One item", input: ItemDto })
export class StopItemStart {}

@WorkflowFinish({ name: "stop-item-workflow-finish", description: "Checked", output: ItemDto })
export class StopItemFinish {}

@Workflow({
  name: "stop-item-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.AnyWorker,
  flow: [onStart(StopItemStart).toAction(StopHoldAction).toFinish(StopItemFinish)],
})
export class StopItemWorkflow {}

@WorkflowStart({
  name: "stop-batch-workflow-start",
  description: "Items, each a child on any instance",
  input: listOf(ItemDto),
})
export class StopBatchStart {}

@Action({
  name: "stop-summary-action",
  description: "Names what was checked",
  input: { results: listOf(ItemDto) },
  output: StopSummaryDto,
})
export class StopSummaryAction implements ActionHandler<StopSummaryAction> {
  execute(input: InputOf<StopSummaryAction>): Promise<OutputOf<StopSummaryAction>> {
    return Promise.resolve({ text: input.results.map((result) => result.name).join(", ") });
  }
}

@WorkflowFinish({
  name: "stop-batch-workflow-finish",
  description: "What was checked",
  output: StopSummaryDto,
})
export class StopBatchFinish {}

@Workflow({
  name: "stop-batch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxConcurrency: 30 },
  flow: [
    onStart(StopBatchStart)
      .forEachItem(toWorkflow(StopItemWorkflow), { takeFirst: 4, maxConcurrency: 4 })
      .join()
      .toAction(StopSummaryAction)
      .toFinish(StopBatchFinish),
  ],
})
export class StopBatchWorkflow {}

@Budget({
  name: "stop-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class StopApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "stop-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class StopTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "stop-execution-budget", scope: BudgetScope.Execution })
export class StopExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

/** SQLite keeps the rest, and the ids Redis's leases hand out (its lease row is their authority). */
@DatabaseStorage({
  name: "stop-database-storage",
  description: "The stop tests' SQLite file",
  driver: SqliteDriver({ path: env("AGBOSS_STOP_SQLITE_PATH") }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
})
export class StopDatabaseStorage {}

/** Redis coordinates: the leases, the child queue and the rate limits. */
@ClusterStorage({
  name: "stop-cluster-storage",
  description: "The stop tests' Redis",
  driver: RedisDriver({ url: secret("AGBOSS_STOP_REDIS_URL"), keyPrefix: "stop:" }),
})
export class StopClusterStorage {}

@Application({
  name: "stop-application",
  version: "1.0.0",
  storage: { database: StopDatabaseStorage, cluster: StopClusterStorage },
  workflows: [StopBatchWorkflow, StopItemWorkflow],
  budgets: [StopApplicationBudget, StopTenantBudget, StopExecutionBudget],
})
export class StopApplication {}
