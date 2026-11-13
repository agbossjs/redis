# @agboss/redis

Redis coordination stores for [AGBoss](https://github.com/agbossjs/agboss): several application
instances share execution leases, the child queue and provider rate limits on one Redis — fast,
short-lived coordination state. Not a whole application: threads, checkpoints, fenced effects,
outbound calls, pauses, records, the audit log, the kept execution ids and the A2A tasks stay in
PostgreSQL or MongoDB (agbossjs/agboss#527, #693, #824).

> Not published to npm yet: it ships with the 0.1.1 release.

## The stores

| Contract                        | Store                                | How it maps to Redis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionLeaseRepository`      | `RedisExecutionLeaseRepository`      | one hash per tree; every operation one Lua script; expiry by the server's `TIME` inside the script; epochs only grow                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ChildExecutionQueueRepository` | `RedisChildExecutionQueueRepository` | a hash per child, one sorted set of the queued (deepest first, then longest waiting); save, claim, complete each one script; the depth (`countByStatus`) one script over the queued by time and the running, kept by the same scripts; the watch (`watchQueued`, agbossjs/agboss#777): the save script publishes on `<prefix>child-queued`, each instance subscribes on a connection of its own — a child another instance queued is claimed at once, not at the 30 s sweep; a dropped subscription reconnects (1 s doubling, at most 30 s), subscribes again and wakes once, the sweep the floor |
| `RateLimitRepository`           | `RedisRateLimitRepository`           | slots a sorted set (slot → its end), windows a sorted set and a hash, pauses a string — each operation one script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Why these and no other: the core's one-backend rule (#526) binds the fenced-effect and outbound-call
stores to the lease store; rate limits, the queue and the audit log are on any backend. Of those,
rate limits and the queue are pure coordination — a slot, a window, a queued child. The audit log
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

## Listing the stores, and the kept execution ids

`REDIS_COORDINATION_STORES` is every store of this package — the leases, the child queue, the rate
limits — to spread into `@Application({ providers })` (agbossjs/agboss#891); `agboss describe` still
names each one. They are **coordination only**: pair them with the durable stores of PostgreSQL or
MongoDB that leave the coordination and fencing stores out (`POSTGRES_DURABLE_STORES`,
`MONGODB_DURABLE_STORES`), and list no fenced-effect or outbound-call store.

Every execution id is kept forever by the lease store (`claimExecutionId`, #591). Redis keeps none:
`RedisExecutionLeaseRepository` injects `EXECUTION_ID_STORE`, and the application gives it its
durable lease store by class — created by the container under that token only, so it is neither a
second lease store (`[di.ambiguous-implementation]`) nor made with `new`:

```ts
import { EXECUTION_ID_STORE, provide } from "@agboss/core";
import { MONGODB_DURABLE_STORES, MongoConnection, MongoExecutionLeaseRepository } from "@agboss/mongodb";
import { REDIS_COORDINATION_STORES, RedisConnection } from "@agboss/redis";

// @Application({ …, providers: [
//   MongoConnection, ...MONGODB_DURABLE_STORES,
//   RedisConnection, ...REDIS_COORDINATION_STORES,
//   provide(EXECUTION_ID_STORE, MongoExecutionLeaseRepository), // or PostgresExecutionLeaseRepository
// ] })
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
settings starts, and `connection.durability()` reports `{ problems, optOut:
RedisDurabilityOptOut.AcknowledgedWritesMayBeLost }`. A crash can
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
`remaining` on that clock. A test's clock is used instead only when `StoreClock.source` is not
`StoreTimeSource.Database` (the contract suites). Rate limits and the queue use the framework's `Clock`, as the contracts
say (rate-limit slots are not money, Guarantees A10).

## The connection

```ts
import { Secret } from "@agboss/core";

export class AppEnvironment {
  redisUrl!: Secret; // redis://user:password@host:6379/0 — secret("REDIS_URL")
  redisDurabilityOptOut?: string; // only "acknowledged-writes-may-be-lost"
  redisKeyPrefix?: string; // default "agboss:" — several applications on one server
  redisWatchLivenessSeconds?: number; // the longest a silently dead subscription goes unnoticed: 10 (default), at least 2
}
```

**A subscription that dies silently** (agbossjs/agboss#789) — a half-open TCP connection behind a
NAT or a load balancer: no FIN, no RST, the wake-ups of the child queue just stop — is noticed
within `redisWatchLivenessSeconds` (default 10 s, at least 2): the subscriber runs a `PING` every
half of it (5 s; `PING` is allowed on a subscribed connection) and the answer is due within the
other half; node-redis keeps TCP keepalive on its socket as well. A connection that does not answer
is destroyed, `child-queue.watch-connection-lost` is logged at `warn`, and a new subscriber
subscribes after the first pause (1 s), waking the claimers once: a child queued during the gap
waits for neither the sweep nor the next message. The worst case is the bound, plus 1 s, plus a
connection (a new connection that is swallowed too is dropped at the bound and tried again, 2 s
later, doubling up to 30 s). A connection that drops loudly reconnects as before.

**One prefix per database.** A lease key is never deleted or expired, and a retired lease is never
taken again (a finished execution's id is never run again). The execution ids come from the
durable store under `EXECUTION_ID_STORE`: a database emptied or replaced under a Redis that was not
— or two applications on one Redis, each with its own database, under one prefix — hands out an id
whose lease key already exists, and no take of it would ever succeed. The claim of such an id fails
with `RedisLeaseKeyConflictError` (`redis.lease-key-conflict`, naming the id only): give each
database its own `redisKeyPrefix`, or empty the keys of the discarded one. (The PostgreSQL, MongoDB
and SQLite lease stores keep their ids and their leases in one database, so they cannot disagree.)

`RedisConnection` (`deps: [ApplicationContext]`, or `new RedisConnection({ url })` in a script or a
test) holds one [node-redis](https://github.com/redis/node-redis) client (`@redis/client`) per
application instance. At `onInit` it connects and runs the start checks. If the server is down, the
start fails after five quick retries instead of hanging; once connected, a dropped connection is
retried indefinitely (an operation in flight rejects, and the core hands the tree over).

Its checks are queries and assertions apart (agbossjs/agboss#891): `topology()` reports the
server's `role`, whether cluster mode is on and each problem, `durability()` each durability setting
found short and the opt-out given — neither throws; `requireSupportedTopology()` rejects with
`RedisDeploymentError` (`redis.deployment-unsupported`), `requireDurability()` with
`RedisDurabilityError` (`redis.durability-insufficient`, unless the opt-out accepts it) — what the
start runs.

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
- `tests/layout/` — the one-backend rule refuses Redis leases beside another backend's fencing store;
  the leases' ids kept under `provide(EXECUTION_ID_STORE, …)` on a real application's container.

The integration tests need a durable Redis (`AGBOSS_REDIS_TEST_URL`), one with the defaults
(`AGBOSS_REDIS_WEAK_TEST_URL`) and a replica (`AGBOSS_REDIS_REPLICA_TEST_URL`); the crash test the
durable server's container name (`AGBOSS_REDIS_CRASH_CONTAINER`). Locally, without them, they are
skipped with a notice; in CI they never skip.

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
