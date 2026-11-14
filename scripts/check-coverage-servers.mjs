#!/usr/bin/env node
// agbossjs/agboss#1047: `npm run coverage` (and so `npm run check`) holds the whole suite to its
// thresholds and to "every test file ran" (check-test-run.mjs); the integration tests and the
// store contracts skip without their Redis servers, so without them that gate cannot pass. Say so
// plainly, before the build, instead of failing on coverage lines. `npm test` runs what can run
// (the rest is skipped, the run says so). Exit 1 when a server URL is missing, 0 when all are set.
import { fileURLToPath } from "node:url";

export const SERVER_VARIABLES = [
  "AGBOSS_REDIS_TEST_URL",
  "AGBOSS_REDIS_WEAK_TEST_URL",
  "AGBOSS_REDIS_REPLICA_TEST_URL",
];

/** The server variables `env` leaves unset or empty. */
export function missingServers(env) {
  return SERVER_VARIABLES.filter((name) => (env[name] ?? "") === "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = missingServers(process.env);
  if (missing.length > 0) {
    console.error(
      `check-coverage-servers: ${missing.join(", ")} not set. The coverage gate (npm run check) runs every integration test and store contract, so it needs the Redis servers (CONTRIBUTING.md; in CI they are set). Without them \`npm test\` runs what can run and skips the rest.`,
    );
    process.exit(1);
  }
}
