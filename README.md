# @agboss/redis

Redis coordination stores for [AGBoss](https://github.com/agbossjs/agboss): several application
instances share execution leases, the child queue and provider rate limits on one Redis — fast,
short-lived coordination state. Not a whole application: threads, checkpoints, fenced effects,
outbound calls, pauses, records, the lease log, the kept execution ids and the A2A tasks stay in
PostgreSQL or MongoDB (agbossjs/agboss#527, #693, #824).

> Not published to npm yet: it ships with the 0.1.1 release.

## The stores

| Contract                        | Store                                      | How it maps to Redis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionLeaseRepository`      | `RedisExecutionLeaseRepository` (abstract) | one hash per tree; every operation one Lua script; expiry by the server's `TIME` inside the script; epochs only grow                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ChildExecutionQueueRepository` | `RedisChildExecutionQueueRepository`       | a hash per child, one sorted set of the queued (deepest first, then longest waiting); save, claim, complete each one script; the depth (`findQueueDepth`) one script over the queued by time and the running, kept by the same scripts; the watch (`watchQueued`, agbossjs/agboss#777): the save script publishes on `<prefix>child-queued`, each instance subscribes on a connection of its own — a child another instance queued is claimed at once, not at the 30 s sweep; a dropped subscription reconnects (1 s doubling, at most 30 s), subscribes again and wakes once, the sweep the floor |
| `RateLimitRepository`           | `RedisRateLimitRepository`                 | slots a sorted set (slot → its end), windows a sorted set and a hash, pauses a string — each operation one script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Why these and no other: the core's one-backend rule (#526) binds the fenced-effect and outbound-call
stores to the lease store; rate limits, the queue and the lease log are on any backend. Of those,
rate limits and the queue are pure coordination — a slot, a window, a queued child. The lease log
is a record (its rows go into exported history), the trees keep undo marks (P5), the mesh store
keeps answers: they belong with the durable rows. So do the A2A tasks an application serves
(agbossjs/agboss#824): a task and the messages accepted for it are what a resent `messageId` is
deduplicated against within the task retention (24 h by default) — a payment's one execution —, and
a lost or evicted key would accept it again. An application that serves A2A (`@A2AExpose`) on these
leases lists `PostgresA2ATaskRepository` or `MongoA2ATaskRepository`; with the in-memory default
assembly refuses it (`[a2a.task-store-not-shared]`).

**Never here, by design:** a fenced-effect or outbound-call store. Their guarantee — the lease
checked in the business write's own transaction (ADR-0026, Guarantees A2) — needs one database
holding both.

## Redis leases beside PostgreSQL or MongoDB: what is safe

A fenced write on PostgreSQL must refuse a holder whose lease was just taken over — **even when the
zombie reaches the write first** (Guarantees P1). PostgreSQL can do that only by reading the lease
row in the write's transaction, under its lock. A Redis lease cannot be in that transaction: a check
of the Redis lease followed by the PostgreSQL commit leaves a gap in which the lease expires and
another instance takes it, and a high-water mark of tokens alone lets a zombie that wakes before the
new holder's first write through (ADR-0026). No commit deadline closes it — PostgreSQL may apply a
`COMMIT` after any deadline a client checked before sending it.

So the combination is **refused**: a Redis lease store with a PostgreSQL, MongoDB or SQLite
fenced-effect or outbound-call store fails assembly with `[application.store-backend-mismatch]`
(tested in `tests/layout/store-layout.test.ts`); the rule is not weakened. What you can run:

- **Redis queue and rate limits, everything else on PostgreSQL / MongoDB** (leases included) — the
  recommended layout for payments: no atomic step spans the two.
- **Redis leases, queue and rate limits, no fenced-effect or outbound-call store** — for
  applications that make no fenced write or outbound call; their other stores (records, trees,
  pauses, checkpoints) on PostgreSQL or MongoDB.

## Kept execution ids

Every execution id is kept forever by the lease store (`saveExecutionIdIfAbsent`, #591). Redis
keeps none: `RedisExecutionLeaseRepository` is abstract and takes the store that keeps them — your
durable lease store, never listed itself:

```ts
import { ApplicationContext, Injectable, StoreClock } from "@agboss/core";
import { PostgresConnection, PostgresExecutionLeaseRepository } from "@agboss/postgres";
import { RedisConnection, RedisExecutionLeaseRepository } from "@agboss/redis";

@Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext, PostgresConnection] })
export class AppExecutionLeases extends RedisExecutionLeaseRepository {
  constructor(
    redis: RedisConnection,
    clock: StoreClock,
    app: ApplicationContext,
    postgres: PostgresConnection,
  ) {
    super(redis, clock, app, new PostgresExecutionLeaseRepository(postgres, clock, app));
  }
}
```

## Required server settings

`RedisConnection` checks the server at start and refuses to start, naming every setting found short:

| Setting                       | Required     | Why                                                                                   | Error                  |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------- | ---------------------- |
| `appendonly`                  | `yes`        | without the append-only file a crash loses every write since the last RDB snapshot    | `RedisDurabilityError` |
| `appendfsync`                 | `always`     | `everysec` loses up to a second of acknowledged writes in a crash                     | `RedisDurabilityError` |
| `no-appendfsync-on-rewrite`   | `no`         | `yes` acknowledges writes without an fsync while an AOF rewrite runs                  | `RedisDurabilityError` |
| `maxmemory-policy`            | `noeviction` | any eviction may drop a lease key: its epoch starts again at 1, a token granted twice | `RedisDurabilityError` |
| `CONFIG GET`, `INFO`          | allowed      | a server whose settings cannot be read is not verified, so it is refused              | both                   |
| role                          | `master`     | the leases are written on the primary only                                            | `RedisDeploymentError` |
| cluster mode                  | off          | a cluster fails over automatically to an asynchronous replica                         | `RedisDeploymentError` |
| automatic failover (Sentinel) | **none**     | not visible from the client — the operator's part, see below                          | —                      |

```sh
redis-server --appendonly yes --appendfsync always --no-appendfsync-on-rewrite no --maxmemory-policy noeviction
```

**The durability opt-out** names the guarantee given up and accepts no other value:
`redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`. With it a server short on the four
settings starts, and `connection.durability()` reports `{ problems, optedOut: true }`. A crash can
then lose an acknowledged epoch, and the next take grants it again: two holders of one fencing token
(`tests/crash/durability-crash.test.ts` shows it). A replica or a cluster has no opt-out.

Size `maxmemory` for the lease keys: a tree's lease key is never deleted (its epoch must only grow)
— about 150 bytes per tree, for good. The rate-limit keys expire an hour after the last thing in
them matters; a child's row goes when its tree ends.

## Failover

Redis replicates asynchronously: an epoch the primary acknowledged may not be on a replica when that
replica is promoted (Sentinel, a cluster failover, `REPLICAOF NO ONE`). The promoted server hands the
epoch out again — **two live holders with one token**, and their writes indistinguishable to any
fence. `WAIT` does not close it: a write whose `WAIT` timed out is still applied on the primary, and a
failover may promote a replica that missed it. Nothing here makes a failover safe, so the stores
require **one durable primary and no automatic failover** (the Guarantees page states it as an
assumption). After a manual failover, treat every lease as lost: stop the instances, promote, start
them again — the store's epochs then continue from the promoted server's, and no instance trusts a
lease from before.

## Time

A lease's expiry is the server's own `TIME`, read inside each script (agbossjs/agboss#533: every
instance agrees on the instant of expiry whatever its clock says); every take and renewal answers
`remaining` on that clock. A test's clock is used instead only when `StoreClock.isDatabaseTime` is
false (the contract suites). Rate limits and the queue use the framework's `Clock`, as the contracts
say (rate-limit slots are not money, Guarantees A10).

## The connection

```ts
import { Secret } from "@agboss/core";

export class AppEnvironment {
  redisUrl!: Secret; // redis://user:password@host:6379/0 — secret("REDIS_URL")
  redisDurabilityOptOut?: string; // only "acknowledged-writes-may-be-lost"
  redisKeyPrefix?: string; // default "agboss:" — several applications on one server
}
```

`RedisConnection` (`deps: [ApplicationContext]`, or `new RedisConnection({ url })` in a script or a
test) holds one [node-redis](https://github.com/redis/node-redis) client (`@redis/client`) per
application instance. At `onInit` it connects and runs the start checks. If the server is down, the
start fails after five quick retries instead of hanging; once connected, a dropped connection is
retried indefinitely (an operation in flight rejects, and the core hands the tree over).

## Tests

```sh
npm ci && npm run pack:framework && npm run install:packed   # the core at the pinned SHA
npm run check                                                # the gate CI runs
npm run test:faults                                          # the fault suite (CI's faults jobs)
npm run test:crash                                           # kills the test server (CI's step)
```

- `tests/contracts/store-conformance.test.ts` — the core's `storeConformance` on the three stores:
  the lease, queue and rate-limit contracts, the store set, and the interleaving explorer on the
  lease store (every schedule of two instances 8 steps deep, 200 seeded walks of three, the second
  clock ± lease/2, ± lease, ± 10 × lease, both #520 races).
- `tests/contracts/sabotage.test.ts` — the suites bite on Redis: leases on the caller's clock fail
  the explorer's `one-live-holder`; a take made of a read and a write fails the three take races.
- `tests/faults/` — the core's fault suite (its scenarios, linearizability included, then its
  sabotages, each passing only when it charges twice — agbossjs/agboss#831) with the Redis queue
  and rate limits beside the core's SQLite fencing set.
- `tests/crash/` — `docker kill -s KILL` on the server: with the required settings every epoch
  survives; with the AOF off (opted out) an epoch is granted twice.
- `tests/layout/` — the one-backend rule refuses Redis leases beside another backend's fencing store.

The integration tests need a durable Redis (`AGBOSS_REDIS_TEST_URL`), one with the defaults
(`AGBOSS_REDIS_WEAK_TEST_URL`) and a replica (`AGBOSS_REDIS_REPLICA_TEST_URL`); the crash test the
durable server's container name (`AGBOSS_REDIS_CRASH_CONTAINER`). Locally, without them, they are
skipped with a notice; in CI they never skip.

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
