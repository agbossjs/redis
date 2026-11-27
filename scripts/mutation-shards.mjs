/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need the servers of `npm run coverage` (the durable
 * primary, the one with the defaults, the replica: tests/support/server.ts).
 */
/**
 * `timeoutMS` of a shard and the `timeoutFactor` of `stryker.config.mjs` (agbossjs/agboss#1367, agbossjs/mongodb#103):
 * Stryker's limit for one mutant is `timeoutFactor` x the net time of the tests that cover it + `timeoutMS`; a static
 * mutant, or one every test covers, has the net time of the whole shard, and the net time leaves out hooks and setup
 * (the dry run's "overhead"). A mutant no test kills then outlasted the old limit (1.5 x + 20 s), read as a
 * Timeout, and a Timeout counts as killed: a survivor hid in the score. The dry run is one worker alone, the
 * mutants run three at once, so a mutant's run takes up to 3 x the dry run's: the factor is 3 and `timeoutMS` is 3 x
 * the shard's overhead on CI (nightly and main runs of 2026-11-20), 120 s at least, so the limit is 3 x the whole run.
 * A Timeout is then a hang, and `scripts/stryker-timeouts.mjs` fails a job on one not in
 * `scripts/stryker-proven-hangs.json`. A hang of an async test stays vitest's (`testTimeout`, `hookTimeout` of
 * `vitest.mutation.config.ts`). A new shard needs one: read "Initial test run succeeded. Ran N tests in X seconds
 * (net Y ms, overhead Z ms)" and set 3 x Z, rounded up to 10 s, 120 s at least (a hung async test takes about 60 s to be ended by vitest, test then hooks: a lower limit read such a mutant as a Timeout in one run and Killed in the next). The contracts of the store
 * conformance a shard needs are picked in `tests/contracts/mutation-contracts.ts`, never by a `testNamePattern`
 * here: vitest keeps a config's pattern as an override of the pattern Stryker sets for each mutant's covering
 * tests, so every mutant ran every test of the shard.
 */
export const SHARDS = {
  // the lease (D6, #1321e: the cluster's side — one script per take, renewal, end, yield and reclaim,
  // the counter raised past the database's row, the marks' cache that only escalates): its claim, renewal, finish, yield and reclaim as one script each, the server's
  // `TIME` as its clock, the cancel mark (agbossjs/agboss#1117, #1152), the scripts' `EVALSHA`
  // with `EVAL` once on `NOSCRIPT`, and the whitelist that reads a write's error after the send as
  // of unknown outcome (agbossjs/agboss#1017)
  leases: {
    timeoutMS: 120_000,
    mutate: [
      "src/stores/redis-execution-lease.repository.ts",
      "src/stores/leases/*.ts",
      "src/stores/store-time.ts",
      "src/connection/scripts.ts",
      "src/connection/outcome.ts",
    ],
    tests: [
      "tests/contracts/{store-conformance,cluster-lease}.test.ts",
      "tests/connection/{scripts,outcome,script-replies}.test.ts",
      "tests/stores/cluster-coordinator.test.ts",
      "tests/integration/{stores,stored-layout,lease-key-conflict,cancel-mark-durable,cluster-lease,outcome}.integration.test.ts",
    ],
  },
  // the child queue (its saves, claims and the watch that wakes a waiter: agbossjs/agboss#777,
  // #789, #1029) and the rate limits' windows; their direct writes and the depth script's read
  // against the outcome whitelist (#1017)
  "queue-and-limits": {
    timeoutMS: 120_000,
    mutate: [
      "src/stores/redis-child-execution-queue.repository.ts",
      "src/stores/queue/*.ts",
      "src/stores/redis-rate-limit.repository.ts",
      "src/stores/rate-limits/rate-limit-scripts.ts",
      "src/stores/coordination-stores.ts",
    ],
    tests: [
      "tests/contracts/store-conformance.test.ts",
      "tests/connection/{watch-liveness-settings,driver}.test.ts",
      "tests/stores/{queue-watch,queue-watch-liveness,child-queue-placement,instants-refused}.test.ts",
      "tests/integration/{stores,stored-layout,queue-watch,queue-watch-silent-death,outcome}.integration.test.ts",
    ],
  },
  // the start checks that refuse a server which may lose an acknowledged write (durability,
  // one primary: agbossjs/agboss#527 AC3), the settings, the bounded close (#954) and the
  // heartbeat
  connection: {
    timeoutMS: 120_000,
    mutate: [
      "src/connection/durability.ts",
      "src/connection/deployment.ts",
      "src/connection/settings.ts",
      "src/connection/driver-settings.ts",
      "src/driver.ts",
      "src/connection/close-bounded.ts",
      "src/connection/heartbeat.ts",
      "src/connection/redis-connection.ts",
    ],
    tests: ["tests/connection/*.test.ts", "tests/integration/redis-connection.integration.test.ts"],
  },
};

/**
 * The files of `src/` no shard mutates, each with its reason (agbossjs/redis#50):
 * `tests/scripts/mutation-shards-complete.test.ts` fails for a file that is in a shard's `mutate`
 * and here, and for one that is in neither, so a new module gets a conscious assignment.
 */
export const NON_SHARDED_SRC = new Set([
  // the public surface: re-exports, no behaviour a mutant could change
  "src/index.ts",
  // the interface of the client the package hands out: types only
  "src/connection/redis-client.ts",
  // the error classes: a name, a message and the fields the start checks fill; every constructor
  // is read by the tests of the checks that throw it
  "src/errors.ts",
]);

/** The shard `MUTATION_SHARD` names (default `leases`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "leases";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
