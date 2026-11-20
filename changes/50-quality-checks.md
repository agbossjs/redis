---
section: Changed
issue: 50
---

**Every Stryker disable hides exactly one mutant, and every module is in a mutation shard or named as not** (agbossjs/redis#50, written agbossjs/agboss#50 as the fragment check wants it; agbossjs/agboss#1353): `check:suppressions` (so `npm run check`) runs `scripts/stryker-disables.mjs`, the core's, on the `@stryker-mutator/instrumenter` Stryker itself uses: only `// Stryker disable next-line <Mutator>: <reason>` (no `disable all`, no range), exactly one mutant ignored on the line below, a file's ignored mutants are its disables; no allowlist. `tests/scripts/mutation-shards-complete.test.ts` fails for a `src/` module that no shard's `mutate` covers and `NON_SHARDED_SRC` (`scripts/mutation-shards.mjs`) does not name with its reason. Today that is `index.ts` and `errors.ts`; every money or liveness module is in a shard already. No change to the stores' behaviour.
