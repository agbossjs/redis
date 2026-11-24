---
section: Changed
issue: 1152
---

**`RedisExecutionLeaseRepository.requestCancel` and `isCancelRequested` go to the durable lease store
under `EXECUTION_ID_STORE`** (agbossjs/agboss#1152, #1117, #909): the tree's cancel mark is permanent
and lives on its lease row there (PostgreSQL, MongoDB), as the kept execution ids do — nothing of it
is kept in Redis as an authority (the cluster lease store of #1321e pushes a cache of the marks after the row), so a flushed, restored or failed-over Redis loses no cancel, and the sweep reads
the mark from the store that holds it. The constructor refuses a store under `EXECUTION_ID_STORE` that
keeps ids only (it names the missing method). Replaces the no-op `requestCancel` of #909. No
migration.
