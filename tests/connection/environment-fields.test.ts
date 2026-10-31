/**
 * As agbossjs/agboss#511 AC3 for `@agboss/postgres`: `RedisConnection` declares the environment
 * fields it reads (`environmentFields`), so an application that lists it without `redisUrl` in
 * its environment contract fails at assembly with `[environment.missing-field]`, naming the field
 * — before any client is built. The assembly reports every violation at once, so an application
 * with no workflow shows its environment's violations too.
 */
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  createApp,
  GraphRuleError,
  type BudgetHandler,
  type Secret,
} from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { RedisConnection } from "../../src/index.js";

@Budget({
  name: "probe-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class ProbeApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class ProbeTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "probe-execution-budget", scope: BudgetScope.Execution })
class ProbeExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** A contract without the connection's fields. */
class UrllessEnvironment {
  region!: string;
}

/** A contract with the required field; the optional ones absent. */
class RedisEnvironment {
  redisUrl!: Secret;
}

const BUDGETS = [ProbeApplicationBudget, ProbeTenantBudget, ProbeExecutionBudget];

@Application({
  name: "urlless-application",
  version: "1.0.0",
  environment: UrllessEnvironment,
  workflows: [],
  providers: [RedisConnection],
  budgets: BUDGETS,
})
class UrllessApplication {}

@Application({
  name: "redis-application",
  version: "1.0.0",
  environment: RedisEnvironment,
  workflows: [],
  providers: [RedisConnection],
  budgets: BUDGETS,
})
class RedisApplication {}

/** The assembly's violations of the environment contract, as `[code] message`. */
async function environmentViolationsOf(application: new () => object): Promise<string[]> {
  const error: unknown = await createApp(application, { env: "test" }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) throw new Error("expected the assembly to fail");
  return error.violations
    .filter((found) => found.code.startsWith("environment."))
    .map((found) => `[${found.code}] ${found.message}`);
}

describe("redisUrl is checked at assembly", () => {
  it("RedisConnection listed without redisUrl in the contract → [environment.missing-field]", async () => {
    const violations = await environmentViolationsOf(UrllessApplication);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      /^\[environment\.missing-field\] RedisConnection needs redisUrl: Secret in UrllessEnvironment/,
    );
  });

  it("redisDurabilityOptOut is optional: absent, no violation", async () => {
    expect(await environmentViolationsOf(RedisApplication)).toEqual([]);
  });
});
