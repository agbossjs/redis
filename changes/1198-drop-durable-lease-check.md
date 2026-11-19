---
section: Changed
issue: 1198
---

**The constructor of `RedisExecutionLeaseRepository` no longer checks at assembly that the store under `EXECUTION_ID_STORE` has `requestCancel` and `isCancelRequested`** (agbossjs/agboss#1198): the core's `ExecutionIdStore` now carries both, so a store without them does not compile. Pinned to a core that has the change. No migration.
