---
section: Breaking
issue: 1324
---

**The connection is the storage's, not the environment's** (agbossjs/agboss#1324): `RedisConnection`
reads its settings from the application's `@ClusterStorage({ driver: RedisDriver({ url }) })` (or a
settings object a script or a test gives); the `redis…` environment fields, `environmentFields` and the
assembly check on them are gone — `RedisDriver`'s `keyPrefix`, `durabilityOptOut` and
`timeouts.watchLiveness` are where they went. An application with no Redis storage and no settings
fails with `RedisSettingsError`. The connection and the two coordination stores declare
`static store = { backend: "redis" }`, which is what puts them on a `@ClusterStorage` in the core's
fault suite (`FaultStoreSet.storage` with `cluster`: the SQLite fencing stores on the database, these
on Redis). A store class listed in `providers` beside a `storage` is `[storage.providers-conflict]`.
