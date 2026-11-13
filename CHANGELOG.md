# Changelog

All notable changes to `@agboss/redis`, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. The package is versioned with
`@agboss/core` and released right after it, as one train (agbossjs/agboss `RELEASE_CHECKLIST.md`):
`@agboss/redis@X.Y.Z` declares the peer dependency `@agboss/core` `^X.Y.Z` and is built and
tested against the `@agboss/core@X.Y.Z` on npm. Before 1.0 a minor release may break the API; the
exact public surface is `api/redis.api.md`. Issue numbers are agbossjs/agboss's, pull requests
this repository's.

## [Unreleased] — 0.1.1 (draft: the first release)

The first published version. Redis holds the **coordination stores only** — the execution leases,
the child queue and the rate limits — beside a durable store (`@agboss/postgres` or
`@agboss/mongodb`) that keeps everything a payment depends on: the fenced effects, the outbound
calls, the records, the A2A tasks. `0.1.0` in `package.json` was never published; every entry below
is against the pre-release builds, so only a store or a test written against `main` of this
repository changes.

### Added

- **The Redis coordination stores** (#693, #527; #1, #2) — on one `@redis/client` (node-redis) per
  instance, backend `"redis"`:
  - `RedisExecutionLeaseRepository`: one Lua script per operation; a lease's expiry is decided by
    the server's `TIME`, and tokens only grow. The execution ids it hands out are kept by the
    application's durable lease store, given with
    `provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)` (or
    `MongoExecutionLeaseRepository`): the container creates it under the token only, so there is
    no second lease store.
  - `RedisChildExecutionQueueRepository`: one script per decision, and `countByStatus()` (#485) —
    the queued and running children and the longest-waiting queued one in one script, feeding
    `agboss.cluster.children.queued` / `.running` / `.oldest_queued_seconds`. `watchQueued` (#777):
    the save script publishes on `<prefix>child-queued` after it writes, so a message goes out only
    for a saved child; each watch subscribes on a connection of its own and is idle on an empty
    queue. A dropped connection reconnects 1 s, 2 s, … at most 30 s apart and wakes the claimers
    once when back, standing in for the messages lost while down; a server that does not answer
    rejects the watch, and the core opens it again at its next sweep. The core's 30 s sweep stays
    the floor. Declared as `StoreCapability.WatchQueued`.
  - `RedisRateLimitRepository`: slots, windows and pauses, one script per decision.
  - `REDIS_COORDINATION_STORES` is the three of them, `as const`, to spread into `providers`.
- **A connection that refuses a server that may lose a write** (#527, #693; #1, #2, #15) —
  `RedisConnection` (environment fields `redisUrl: Secret`, `redisDurabilityOptOut`, optional
  `redisKeyPrefix`, default `agboss:`) checks at start that the server is one durable primary:
  `appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite no` and
  `maxmemory-policy noeviction`; a replica or a cluster is refused. A server that refuses
  `CONFIG GET` (some managed Redis) cannot be verified and counts as a problem, never a pass.
  `RedisDurabilityError` (`redis.durability-insufficient`) and `RedisDeploymentError`
  (`redis.deployment-unsupported`) name each problem. The only opt-out is
  `redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`; any other value is a
  `RedisSettingsError`, so there is no vague `true`. `topology()` and `durability()` are reports that
  never throw (`RedisDurability { problems, optOut? }`); `requireSupportedTopology()` and
  `requireDurability()` throw, and the start runs them. A first connect never hangs: it retries five
  times (about 1.5 s) and then rejects; after it is ready, reconnects are unlimited. Failover cannot
  be checked from the client: run one primary with no automatic failover (the README says so).
- **One prefix per database** (#923; #16) — when the execution-id store hands out an id as new and
  a lease key of that id already exists in Redis, `claimExecutionId` fails with
  `RedisLeaseKeyConflictError` (`redis.lease-key-conflict`; the message names the id and the fix,
  never the key's content). Before, every take of such an execution was refused for ever (a retired
  lease is never taken again) and the caller retried without end. Use one `redisKeyPrefix` per
  database.
- **One backend for the fencing stores** (#526) — the lease store declares
  `static store = { backend: "redis" }` (#825); a layout that puts the fenced effects or the outbound
  calls on Redis, or beside leases of another backend, fails assembly. Redis keeps no A2A tasks
  either (#824; #6): a task and the messages accepted for it are what a resent `messageId` is
  deduplicated against, and a lost or evicted key would accept the message again. An application
  that serves A2A on Redis leases lists `PostgresA2ATaskRepository` or `MongoA2ATaskRepository`,
  or the core refuses it at assembly (`[a2a.task-store-not-shared]`).
- **The server's clock decides a lease's expiry** (#533, #847; #11) — a lease script reads the
  server's `TIME` when the store's clock is `StoreTimeSource.Database` (the core's `StoreClock.source`);
  `yield` answers the milliseconds the lease has left, or `undefined` once the lease is not the
  caller's.
- **Proved against real servers** — the core's `storeConformance` with the interleaving explorer on
  the lease store alone (#694), the fault suite (its sabotages too, #831) with Redis beside SQLite
  fencing, and a crash test that SIGKILLs the server (with the AOF off an epoch is granted twice),
  on a durable, a default-configured and a replica server.
- **The release workflow** (#691; #3) — a pushed tag `redis-vX.Y.Z` publishes to npm with
  provenance, only when the tag is the package's version, the commit is on `main`, the pin takes
  `@agboss/core` from the registry at a published version the peer range names
  (`.agboss-version.json` `source: "registry"`, `node scripts/pin-framework.mjs --registry X.Y.Z`)
  and `ci.yml` passed on that commit; a dry run on every pull request that touches it.

### Changed

- **One options object for every error, `Turn` to the end** (agbossjs/agboss#906; #17, #19) — every
  error of the package is made from one options object whose keys are its own properties, with a
  `cause` and a literal instance `code` (message only: `{ message, cause }`); the store contract's
  `lastTerns` is `lastTurns`, a summary's `fromTernId` / `toTernId` are `fromTurnId` / `toTurnId`
  (no `Tern` stays in the API report). Redis has no record or paused-run store, so nothing stored
  changes.
- **The core's #891, API review G11** (#15) — the lease store is a concrete `@Injectable` over
  `[RedisConnection, StoreClock, ApplicationContext, EXECUTION_ID_STORE]`; `KeptExecutionIds` is gone.
  `deployment()` is split into `topology()` / `requireSupportedTopology()`, and `optedOut: boolean`
  is `RedisDurability.optOut`; the two errors take an options bag (`new RedisDeploymentError({
problems })`); `RedisConnection.subscriber()` is `@internal`.
- **The core's #890 (G8), #889 (G6), #847 (G7), #834 (G2), #825** — each error's static `code` is its
  literal; the conformance set leaves out `stores.executionAuditLog` (Redis keeps no audit log);
  `leaseEpoch` is `token`, `finish` is `retire`, `saveExecutionIdIfAbsent` is `claimExecutionId`,
  the parameter `lease` is `duration`, `findQueueDepth` is `countByStatus` (`ChildExecutionQueueCounts`);
  the stored hash fields are unchanged; the connection's environment fields are made by
  `EnvironmentField`'s helpers.

### Fixed

- **A close at an instance's stop does not wait for a quiet server** (#923; #18) —
  `RedisConnection`'s `onDestroy` closes in order and destroys the socket after a 1 s grace on the
  `Clock` (a command in flight rejects, nothing rejects unhandled later); so does the queue watch's
  subscriber.
