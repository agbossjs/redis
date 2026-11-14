/**
 * agbossjs/agboss#1047 — `scripts/check-coverage-servers.mjs` (the `precoverage` step of `npm run
 * check`): without the Redis servers the coverage gate says so plainly instead of failing on
 * coverage lines; with all three set it passes.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const script = `${repo}scripts/check-coverage-servers.mjs`;

const ALL = {
  AGBOSS_REDIS_TEST_URL: "redis://127.0.0.1:1",
  AGBOSS_REDIS_WEAK_TEST_URL: "redis://127.0.0.1:2",
  AGBOSS_REDIS_REPLICA_TEST_URL: "redis://127.0.0.1:3",
};

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });

describe("agbossjs/agboss#1047: the coverage gate names the missing servers", () => {
  it("fails naming every unset variable, and says what runs without them", () => {
    const result = run({});
    expect(result.status).toBe(1);
    for (const name of Object.keys(ALL)) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("npm test");
  });

  it("names only the one that is unset or empty", () => {
    const result = run({ ...ALL, AGBOSS_REDIS_WEAK_TEST_URL: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGBOSS_REDIS_WEAK_TEST_URL");
    expect(result.stderr).not.toContain("AGBOSS_REDIS_TEST_URL");
  });

  it("passes with all three set", () => {
    expect(run(ALL).status).toBe(0);
  });
});
