---
section: Changed
issue: 1213
---

**The package meets the core's quality bar** (agbossjs/agboss#1213): the money-path modules — the lease and its scripts, the child queue and its watch, the rate limits, the start checks — are mutation-tested with Stryker at 100 % killed or justified (`MUTATION_SHARD=<shard> npm run test:mutation`; CI runs each shard incrementally, a nightly run cold); `npm run check:static` is the cheap half of the gate (the root allowlist, knip, the docs' ts blocks compiled against the build, lint, types, the API report); the lint forbids `@agboss/core/internal`, the core's testing entries in `src/`, a faked interrupt and a synchronous child process in a test; the vendored `check-real-time` and `check-installs` are the core's current ones. No change to the stores' behaviour.
