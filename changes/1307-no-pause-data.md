---
section: Changed
issue: 1307
---

**Pinned on core `main` 3c1a88f9d (P6b, `Date`s in the pause store contract)** (agbossjs/agboss#1307): Redis keeps no pause store, no pause record, no notice and no answer log — only leases, the child queue and rate limits — so there is nothing to port of the pause contract. The times the stores take are checked as the P6b rule says: `RedisRateLimitRepository.pauseUntil` (the end of a provider pause) and `RedisChildExecutionQueueRepository.saveIfAbsent` (`queuedAt`, `claimedAt`) refuse an Invalid Date with `StoreError.UnreadableRecord` naming the field, before anything is sent (it would reach a script as `NaN` and be kept as a row nobody can read). Times stay millisecond numbers in the keys and rows, never text, so no `toISOString` spelling is involved. No migration.
