---
section: Breaking
issue: 1325
---

**The store errors are the core's `StoreError` variants** (agbossjs/agboss#1325): a command whose answer was lost is `StoreError.OutcomeUnknown` (`store`, `operation`, `source`); an error that already is a store call of unknown outcome passes through, `StoreError.CallTimeout` too (a variant of its own now, no longer a subclass of `StoreError.OutcomeUnknown` — test both with `isStoreOutcomeUnknown(error)` from `@agboss/core/stores`). The `StoreOutcomeUnknownError` and `StoreCallTimeoutError` classes are gone from the core. No migration.
