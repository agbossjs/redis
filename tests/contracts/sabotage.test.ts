import { runConformanceSabotage, type SabotageCase } from "@agboss/core/testing/contracts";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * agbossjs/agboss#693 AC3 — the core's suites bite on Redis: two broken lease stores
 * (fixtures/sabotage-stores.ts) run through `storeConformance` in a vitest of their own, and each
 * fails what it breaks. Leases decided on the caller's clock (the client sends its own time, not the
 * server's `TIME`) fail the explorer's `one-live-holder`; a take made of a read and then a write
 * (two round trips, not one script) fails the lease contract's three take races (agbossjs/agboss#695) on every run. The third
 * sabotage — a server without fsync claiming durability — is refused at start
 * (tests/integration/durability-crash.test.ts shows what it loses).
 */
let found: readonly SabotageCase[] = [];

beforeAll(async () => {
  // agbossjs/agboss#831: the core's runner — a fixture that does not load, a hook that fails or a
  // path that names nothing rejects here, never an empty run
  const run = await runConformanceSabotage({
    root: new URL("../../", import.meta.url),
    fixtures: ["tests/contracts/fixtures/sabotage.conformance-fixture.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  });
  found = run.cases;
}, 1_200_000);

const failedIn = (suite: string): SabotageCase[] =>
  found.filter((one) => one.suites[0] === suite && one.state === "fail");

describe("agbossjs/agboss#693 AC3: the suites bite on broken Redis lease stores", () => {
  it("leases on the caller's clock: the explorer fails one-live-holder with a minimal schedule", () => {
    const failed = failedIn("interleavings (Redis leases on the caller's clock)");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((one) => (one.errors[0] ?? "").includes("): [one-live-holder]"))).toBe(true);
    expect(failed.map((one) => one.errors[0] ?? "").join("\n")).toContain("minimal schedule");
  });

  it("a take made of a read and a write: the lease contract's three take races fail", () => {
    const failed = found.filter(
      (one) =>
        one.suites.some((suite) => suite.includes("Redis leases taken by a read, then a write")) &&
        one.state === "fail",
    );
    // both take races, every run; under load a case whose own steps race two calls may fail too
    // (the store is broken there as well) — never a case of one call at a time
    expect(failed.map((one) => one.name)).toEqual(
      expect.arrayContaining(
        ["never leased", "released", "expired"].map(
          (how) =>
            `#695: two instances take one ${how} lease at once, round after round, in both orders: exactly one is given it, at the next epoch`,
        ),
      ),
    );
    expect(failed.length).toBeLessThanOrEqual(5);
  });

  it("the sound parts of both still pass: only what they break fails", () => {
    const passed = found.filter((one) => one.state === "pass");
    expect(passed.length).toBeGreaterThan(20);
  });
});
