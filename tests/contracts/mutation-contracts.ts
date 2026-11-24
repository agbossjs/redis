import process from "node:process";
import type { StoreSet } from "@agboss/core/testing/contracts";

/**
 * The stores whose contracts a mutation shard needs of `store-conformance.test.ts` (agbossjs/agboss#1367): the
 * queue and limits shard leaves the lease store's contract and the interleaving explorer to the leases shard,
 * which touch none of its modules and take most of the run. The file leaves them out, never the vitest config
 * (`testNamePattern`): vitest keeps a config's pattern as an override of the pattern Stryker sets for each
 * mutant's covering tests, so every mutant then ran every test of the shard. Every run outside a mutation
 * run and every other shard run all of them.
 */
export const CONTRACTS_OF_SHARD: Readonly<Record<string, readonly (keyof StoreSet)[]>> = {
  "queue-and-limits": ["childExecutionQueue", "rateLimit"],
};

/** `stores` with the contracts `MUTATION_SHARD` needs, or all of them when it names no shard of the map. */
export function storesOfShard(
  stores: StoreSet,
  shard: string | undefined = process.env.MUTATION_SHARD,
): StoreSet {
  const keep = shard === undefined ? undefined : CONTRACTS_OF_SHARD[shard];
  if (keep === undefined) return stores;
  return Object.fromEntries(
    Object.entries(stores).filter(([key]) => keep.some((kept) => kept === key)),
  );
}
