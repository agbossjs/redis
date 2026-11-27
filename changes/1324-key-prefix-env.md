---
section: Added
issue: 1324
---

**`RedisDriver({ keyPrefix })` takes `string | EnvRef<string>`** (agbossjs/agboss#1324): `keyPrefix: env("REDIS_KEY_PREFIX")` is read once when the application starts, as the url's `secret(…)` is (a per-run or per-environment prefix needs no code change), the core resolves it before the connection reads its settings, and every key (leases, the child queue, rate limits, the lease marks' channel) is built from the resolved prefix. The driver's description names the variable (`redis (key prefix from REDIS_KEY_PREFIX)`). An empty prefix is still refused. No migration.
