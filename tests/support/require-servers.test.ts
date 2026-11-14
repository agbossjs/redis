/**
 * agbossjs/agboss#1047 AC3 — the global setup's guard: in CI (`CI` set) a missing server URL fails
 * the run before any test, never a silent skip; locally it is a notice and the tests skip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireServers } from "./global-setup.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("agbossjs/agboss#1047: a missing server URL", () => {
  it("fails in CI, naming the variable", async () => {
    vi.stubEnv("CI", "true");
    await expect(requireServers([["AGBOSS_REDIS_TEST_URL", ""]])).rejects.toThrow(
      /AGBOSS_REDIS_TEST_URL not set in CI: the integration tests never skip there/u,
    );
  });

  it("is a skip notice locally, not a failure", async () => {
    vi.stubEnv("CI", "");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await requireServers([["AGBOSS_REDIS_TEST_URL", ""]]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("are SKIPPED"));
  });
});
