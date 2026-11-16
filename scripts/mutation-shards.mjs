/**
 * The mutation shards of this package (agbossjs/agboss#1213, as the core's stryker.config.mjs,
 * #533 item 3, #626): each the money-path modules it mutates and the tests that must kill them.
 * Read by `stryker.config.mjs` (what to mutate) and `vitest.mutation.config.ts` (what to run);
 * `MUTATION_SHARD` picks one. The tests need the servers of `npm run coverage` (the durable
 * primary, the one with the defaults, the replica: tests/support/server.ts).
 */
export const SHARDS = {
  // the lease: its claim, renewal, finish, yield and reclaim as one script each, the server's
  // `TIME` as its clock, the cancel mark (agbossjs/agboss#1117, #1152), the scripts' `EVALSHA`
  // with `EVAL` once on `NOSCRIPT`
  leases: {
    mutate: [
      "src/stores/redis-execution-lease.repository.ts",
      "src/stores/leases/lease-scripts.ts",
      "src/stores/store-time.ts",
      "src/connection/scripts.ts",
    ],
    tests: [
      "tests/contracts/store-conformance.test.ts",
      "tests/connection/scripts.test.ts",
      "tests/integration/{stores,stored-layout,lease-key-conflict,cancel-mark-durable}.integration.test.ts",
    ],
  },
  // the child queue (its saves, claims and the watch that wakes a waiter: agbossjs/agboss#777,
  // #789, #1029) and the rate limits' windows
  "queue-and-limits": {
    mutate: [
      "src/stores/redis-child-execution-queue.repository.ts",
      "src/stores/queue/*.ts",
      "src/stores/redis-rate-limit.repository.ts",
      "src/stores/rate-limits/rate-limit-scripts.ts",
      "src/stores/coordination-stores.ts",
    ],
    tests: [
      "tests/contracts/store-conformance.test.ts",
      "tests/connection/watch-liveness-settings.test.ts",
      "tests/stores/*.test.ts",
      "tests/integration/{stores,stored-layout,queue-watch,queue-watch-silent-death}.integration.test.ts",
    ],
    // the lease cases of the store contracts and their interleavings touch none of these modules
    // and take most of the run's time: left to the leases shard
    testNamePattern: String.raw`^(?!.*(lease contract|interleavings) \(Redis\))`,
  },
  // the start checks that refuse a server which may lose an acknowledged write (durability,
  // one primary: agbossjs/agboss#527 AC3), the settings, the bounded close (#954) and the
  // heartbeat
  connection: {
    mutate: [
      "src/connection/durability.ts",
      "src/connection/deployment.ts",
      "src/connection/settings.ts",
      "src/connection/close-bounded.ts",
      "src/connection/heartbeat.ts",
      "src/connection/redis-connection.ts",
    ],
    tests: ["tests/connection/*.test.ts", "tests/integration/redis-connection.integration.test.ts"],
  },
};

/** The shard `MUTATION_SHARD` names (default `leases`); a name of none fails. */
export function chosenShard() {
  const name = process.env.MUTATION_SHARD ?? "leases";
  const shard = SHARDS[name];
  if (shard === undefined)
    throw new Error(`MUTATION_SHARD: "${name}" is none of ${Object.keys(SHARDS).join(", ")}`);
  return { name, ...shard };
}
