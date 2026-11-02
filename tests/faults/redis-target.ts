import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAULT_SCENARIOS, type FaultSuiteOptions } from "@agboss/core/testing/faults";
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

/** One shard of the scenarios: `k/n` (1 ≤ k ≤ n), every `n`-th from the `k`-th. */
export interface FaultShard {
  readonly index: number;
  readonly count: number;
}

/** The shard `text` names (`AGBOSS_FAULT_SHARD`); `undefined` for none, a `RangeError` when malformed. */
export function faultShardOf(text: string | undefined): FaultShard | undefined {
  if (text === undefined || text === "") return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(text);
  const [index, count] = [Number(match?.[1]), Number(match?.[2])];
  if (match === null || index > count)
    throw new RangeError(`AGBOSS_FAULT_SHARD is "${text}": expected k/n with 1 ≤ k ≤ n`);
  return { index, count };
}

/** The ids of the scenarios of `shard` (every scenario without one). */
export function scenariosOf(shard: FaultShard | undefined): readonly string[] | undefined {
  if (shard === undefined) return undefined;
  return FAULT_SCENARIOS.filter((_, at) => at % shard.count === shard.index - 1).map(
    (scenario) => scenario.id,
  );
}

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
    stores: REDIS_FAULT_STORES,
    timeScale: 10,
    scenarios: scenariosOf(faultShardOf(process.env.AGBOSS_FAULT_SHARD)),
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
