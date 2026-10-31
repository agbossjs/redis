# AGENTS.md — @agboss/redis

AGBoss's coordination stores on Redis (agbossjs/agboss#527): leases, rate limits and the child
queue shared by several application instances. Only coordination stores — the fenced effect and
outbound calls stay on a durable store, enforced by the core's backend check (#526). The package
implements the core's infrastructure contracts; it never changes them. **Status: scaffold** — the
connection only; the stores wait for the core's `storeConformance` (#526) and fault suite (#484).
Do not start a store before both are merged.

## Stack

TypeScript strict, ESM, Node 22+ · node-redis (`@redis/client`, one client per application
instance) · zod for every setting and reply read back · Vitest + v8 coverage, integration tests
against a real Redis (`AGBOSS_REDIS_TEST_URL`) · api-extractor (`api/redis.api.md`).

## Commands

- `npm run pack:framework && npm run install:packed` — `@agboss/core` and `@agboss/cli` at the SHA
  pinned in `.agboss-version.json` (pin the current agboss `main` when a store needs a newer core).
- `npm run check` — format, suppressions (budget 0), reviewed installs (`check:installs`: a
  workflow installs with `npm ci`, a script resolves ranges only with `--before`, three days back —
  agbossjs/agboss#523), no real-time threshold in a test (`check:real-time`), lint, types, tests
  with coverage, API report.

## Architecture

- `src/connection/` — `RedisConnection` (DI token, `deps: [ApplicationContext]`, or
  `new RedisConnection({ url })` in a script/test); its settings from the environment
  (`redisUrl: Secret`, `redisDurabilityOptOut`); the durability check (`durability.ts`:
  `CONFIG GET appendonly` / `appendfsync` → `RedisDurabilityError` unless the opt-out
  `acknowledged-writes-may-be-lost` accepts the loss; a refused `CONFIG GET` is a problem, never a
  pass); the reconnect strategy (a start fails after five retries, a running instance keeps trying).
- `src/errors.ts` — every named error, an `AGBossError` with a stable `redis.*` code.
- `src/stores/` — (pending #526/#484) leases, rate limits, the child queue; every atomic operation
  one Lua script or one `MULTI`, stated in each store's doc comment. Time only from the `Clock`
  (passed to the script, never the server's `TIME`).
- `tests/connection/` — unit tests with fakes (no server); `tests/integration/` — against a durable
  Redis and one with the defaults.

## Rules

- Import only `@agboss/core` public entries (`@agboss/core`, `/units`, `/testing`,
  `/testing/contracts`, `/eslint`); never `/internal`. When the core lacks a public seam a store
  needs, stop and report it on the issue.
- Never add a fenced-effect or outbound-call store here (#527: their guarantee needs a durable
  transaction with the business write).
- The core's limits: 200 lines per file, 50 per function, complexity 10; no `eslint-disable`,
  `@ts-ignore`, `as any`, `as unknown as`. Components keep no state (`agboss/no-component-state`),
  time from the `Clock` (`agboss/no-direct-time`).
- Vitest runs at most two workers (`vitest.config.ts`).
- Integration tests need a real Redis: in CI (`CI` set) a missing URL fails the run; locally they
  are skipped with a notice. Never start a local server from a test or a script.
- Every required database setting has a test that fails when it is not met (#527 AC3).
- Conveyor, labels, branches and PRs as agbossjs/agboss (see CONTRIBUTING.md).
