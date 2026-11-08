# AGENTS.md — @agboss/redis

AGBoss's coordination stores on Redis (agbossjs/agboss#527, #693): execution leases, the child
queue and rate limits shared by several application instances. Only coordination stores — threads,
checkpoints, fenced effects, outbound calls, pauses, records, the lease log and the kept execution
ids stay in PostgreSQL or MongoDB; the core's one-backend check (#526) refuses a fenced-effect or
outbound-call store of another backend beside the Redis leases. The package implements the core's
infrastructure contracts; it never changes them.

## Stack

TypeScript strict, ESM, Node 22+ · node-redis (`@redis/client`, one client per application
instance) · zod for every setting and reply read back · Vitest + v8 coverage, integration tests
against a real Redis (`AGBOSS_REDIS_TEST_URL`) · api-extractor (`api/redis.api.md`).

## Commands

- `npm run pack:framework && npm run install:packed` — `@agboss/core` and `@agboss/cli` at the SHA
  pinned in `.agboss-version.json` (pin the current agboss `main` when a store needs a newer core).
- `npm run check` — format, suppressions (budget 0), reviewed installs (`check:installs`: a
  workflow installs with `npm ci`, a script resolves ranges only with `--before`, three days back —
  agbossjs/agboss#523), no real-time threshold in a test (`check:real-time`), flow types
  (`check:types`: the CLI's `agboss check` on `tests/fixtures/layout.application.ts`, writes the
  uncommitted `.agboss/types.d.ts`), lint, types, tests with coverage held against `test-run.json`
  (`scripts/check-test-run.mjs`, agbossjs/agboss#630), API report.
- `npm run test:faults` — the core's fault suite with the Redis queue and rate limits beside the
  core's SQLite fencing set (`AGBOSS_FAULT_SHARD=k/n` for a shard); `npm run test:crash` — kills the
  test server (`AGBOSS_REDIS_CRASH_CONTAINER`) with SIGKILL and starts it again: alone, never beside
  other tests.

## Architecture

- `src/connection/` — `RedisConnection` (DI token, `deps: [ApplicationContext]`, or
  `new RedisConnection({ url })` in a script/test); its settings from the environment
  (`redisUrl: Secret`, `redisDurabilityOptOut`, `redisKeyPrefix`); the start checks — durability
  (`durability.ts`: `appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite no`,
  `maxmemory-policy noeviction` → `RedisDurabilityError` unless the opt-out
  `acknowledged-writes-may-be-lost` accepts the loss) and one primary (`deployment.ts`: no replica,
  no cluster → `RedisDeploymentError`, no opt-out); a refused `CONFIG GET` / `INFO` is a problem,
  never a pass; the scripts (`scripts.ts`: `EVALSHA`, `EVAL` once on `NOSCRIPT`; `keyOf`, one JSON
  array of parts); the reconnect strategy.
- `src/errors.ts` — every named error, an `AGBossError` with a stable `redis.*` code.
- `src/stores/` — the lease store (abstract: a subclass names the durable store that keeps the
  execution ids), the child queue, rate limits; every atomic operation one Lua script, stated in
  each store's doc comment. A lease's expiry is the server's `TIME` inside the script
  (`store-time.ts`; a test's clock only when `StoreClock.source` is not `StoreTimeSource.Database`); the queue and the
  rate limits use the framework's `Clock`. Lease keys are never deleted or expired. The queue's watch
  (agbossjs/agboss#777, `queue/queue-watch.ts`): the save script publishes, each watch subscribes on
  a connection of its own (`RedisConnection.subscriber()`), a reconnect wakes it once.
- `tests/connection/` — unit tests with fakes (no server); `tests/integration/` — against a durable
  primary, one with the defaults and a replica; `tests/contracts/` — `storeConformance` and the
  sabotage proofs; `tests/faults/`, `tests/crash/`, `tests/layout/` (the one-backend rule on
  `createApp`, typed by `tsconfig.layout.json`).

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- Never add a fenced-effect or outbound-call store here, and never weaken the one-backend check for
  one beside the Redis leases (#527, #693: their guarantee needs the lease in the business write's
  own transaction). The kept execution ids are never kept in Redis.
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Vitest runs at most two workers (`vitest.config.ts`); the fault suite and the crash test one file
  at a time.
- Integration tests need a real Redis: in CI (`CI` set) a missing URL fails the run; locally they
  are skipped with a notice. Never start a local server from a test or a script (the crash test
  only restarts the container it is given).
- Every required database setting has a test that fails when it is not met (#527 AC3).
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
