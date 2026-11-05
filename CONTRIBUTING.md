# Contributing

`@agboss/redis` follows the conveyor of [agbossjs/agboss](https://github.com/agbossjs/agboss):
every change starts as an issue there (stage = its `status:*` label: Triage → Backlog → In progress
→ Test → Done, Done only by a human closing it) and lands here through a squash-merged PR.

## Before a PR

1. `npm ci && npm run pack:framework && npm run install:packed` — the core at the pinned SHA.
2. `npm run check` — the gate CI runs too. The integration tests need a durable Redis, a Redis with
   the defaults and a replica; without `AGBOSS_REDIS_TEST_URL`, `AGBOSS_REDIS_WEAK_TEST_URL` and
   `AGBOSS_REDIS_REPLICA_TEST_URL` they are skipped locally (the run says so) — CI runs them on
   `redis:7`. `npm run test:faults` and `npm run test:crash` (it kills the server named by
   `AGBOSS_REDIS_CRASH_CONTAINER`) run in CI too.

## Branches, commits, PRs

- Branch from `main`: `<type>/<issue>-<slug>` (`chore/527-scaffold`).
- Conventional commits naming the issue: `feat(agbossjs/agboss#527): …`, `fix(…): …`.
- The PR body says `Refs agbossjs/agboss#<issue>`; it is squash-merged when CI is green.
- Labels: `type:feature` · `type:bugfix` · `type:chore` · `prio:mvp` · `blocked`, as the core.

## Releasing

`@agboss/redis` is versioned with `@agboss/core` (a peer dependency range) and published right
after it. Before that, `npm run install:published` checks the package against the registry's core.
