import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaultSuiteOptions } from "@agboss/core/testing/faults";
import { afterAll } from "vitest";
import { DURABLE_URL } from "../support/server.js";

/**
 * agbossjs/agboss#693 AC2 — the fault suite's target: before each scenario a fresh SQLite file for
 * the fencing set and a fresh key prefix on the test's Redis for the coordination stores (the pods
 * inherit both through the environment); the pods' clocks ten times real time, as the core's own
 * SQLite runs (the queue and the slots are on the framework's clock, the SQLite leases on the
 * host's). CI shards the scenarios over parallel jobs (`AGBOSS_FAULT_SHARD`, `k/n`).
 */

export const REDIS_FAULT_STORES = fileURLToPath(
  new URL("./redis.fault-stores.ts", import.meta.url),
);

/** The fault suite's options: fresh files and prefixes of this test file's own. */
export function redisFaultTarget(): FaultSuiteOptions {
  const dir = mkdtempSync(join(tmpdir(), "agboss-redis-faults-"));
  let runs = 0;
  let file = join(dir, "faults-0.sqlite");
  process.env.AGBOSS_FAULT_REDIS_URL = DURABLE_URL;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    name: "Redis coordination stores beside SQLite fencing",
    storesModule: REDIS_FAULT_STORES,
    timeScale: 10,
    // CI's parallel jobs: AGBOSS_FAULT_SHARD=k/n, read by the suite (agbossjs/agboss#831) — the
    // core's sabotages included, each passing only when it breaks its invariant
    shard: "env",
    database: {
      get url() {
        return file;
      },
      reset: () => {
        runs += 1;
        file = join(dir, `faults-${String(runs)}.sqlite`);
        process.env.AGBOSS_FAULT_REDIS_PREFIX = `agboss-faults:${String(process.pid)}:${String(runs)}:`;
      },
    },
  };
}
