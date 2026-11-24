---
section: Added
issue: 1321
---

**`RedisDriver`, and `RedisClient` as the package's own interface** (agbossjs/agboss#1321f): `@ClusterStorage({ driver: RedisDriver({ url: secret("REDIS_URL"), keyPrefix, durabilityOptOut, timeouts: { watchLiveness } }) })` brings the connection and the three coordination stores; the watch's liveness is a `Milliseconds` of `DriverTimeouts` (the environment's `redis…` fields stay for an application with no storage component). `RedisClient` is an exported interface of the commands the package and its users need (`evalSha`, `eval`, `ping`, `exists`, `get`, `hGetAll`, `zRem`, `del`), no longer node-redis's type; `RedisConnection.native` (internal) is the full client.
