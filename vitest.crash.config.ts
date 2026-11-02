import { defineConfig } from "vitest/config";

/**
 * agbossjs/agboss#693 AC3 — the crash test (`npm run test:crash`): it kills the test server with
 * SIGKILL and starts it again, so it runs alone, after the check, never beside other tests.
 */
export default defineConfig({
  test: {
    include: ["tests/crash/**/*.test.ts"],
    expect: { requireAssertions: true },
    globalSetup: ["./tests/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
