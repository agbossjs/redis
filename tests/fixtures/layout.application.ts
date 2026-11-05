import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
  Injectable,
  StoreClock,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  ApplicationContext,
  start,
  type Class,
} from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
import { RedisConnection, RedisExecutionLeaseRepository } from "../../src/index.js";
import { SharedKeptIds } from "../support/redis-store.js";
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

/** The kept ids of the layouts, shared by the instances of one test. */
export const LAYOUT_KEPT_IDS = new SharedKeptIds();

/** An application's Redis lease store: the kept ids in `LAYOUT_KEPT_IDS`, as a durable store would keep them. */
@Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext] })
export class LayoutRedisExecutionLeaseRepository extends RedisExecutionLeaseRepository {
  constructor(connection: RedisConnection, clock: StoreClock, application: ApplicationContext) {
    super(connection, clock, application, LAYOUT_KEPT_IDS);
  }
}

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
export function layoutOf(providers: readonly Class[]): Class {
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
