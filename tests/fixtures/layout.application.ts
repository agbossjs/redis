import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
  EXECUTION_ID_STORE,
  provide,
  SqliteExecutionLeaseRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  start,
  type Class,
  type Provider,
} from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import { LayoutEnvironment } from "./environments/layout.contract.js";

/**
 * agbossjs/agboss#693 — an application on the given stores, for the assembly checks of
 * `tests/integration/store-layout.integration.test.ts`: one workflow that answers its message as
 * it is (no model, no step), its environment the Redis connection's fields and a SQLite path.
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
  flow: [start(EchoWorkflowStart).returns(WorkflowStartTextDto).toFinish(EchoWorkflowFinish)],
})
export class EchoWorkflow {}

/**
 * agbossjs/agboss#891 — the ids the Redis leases hand out, kept by a durable lease store under
 * `EXECUTION_ID_STORE` (SQLite here; PostgreSQL's or MongoDB's in an application): the container
 * creates it under the token only — no `new`, no second lease store.
 */
export const LAYOUT_EXECUTION_IDS = provide(EXECUTION_ID_STORE, SqliteExecutionLeaseRepository);

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

const BUDGETS = [LayoutApplicationBudget, LayoutTenantBudget, LayoutExecutionBudget];

/** The application `npm run check:types` writes the flow types of (no store listed). */
@Application({
  name: "layout-application",
  version: "1.0.0",
  environment: LayoutEnvironment,
  workflows: [EchoWorkflow],
  budgets: BUDGETS,
})
export class LayoutApplication {}

/** An application of the echo workflow on `providers`. */
export function layoutOf(providers: readonly Provider[]): Class {
  @Application({
    name: "layout-application",
    version: "1.0.0",
    environment: LayoutEnvironment,
    workflows: [EchoWorkflow],
    budgets: BUDGETS,
    providers: [...providers],
  })
  class LayoutApplication {}
  return LayoutApplication;
}
