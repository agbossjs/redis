# @agboss/redis

Redis coordination stores for [AGBoss](https://github.com/agbossjs/agboss): several application
instances share execution leases, provider rate limits and the child queue on one Redis — fast,
short-lived coordination state. Not a whole application: the fenced effect and outbound calls stay
on a durable store (PostgreSQL, MongoDB, SQLite).

> **Status: scaffold.** The connection and its durability check are here and tested against a real
> Redis in CI. The stores are pending the core's store conformance
> ([agbossjs/agboss#526](https://github.com/agbossjs/agboss/issues/526)) and fault suite
> ([#484](https://github.com/agbossjs/agboss/issues/484)); the plan is
> [#527](https://github.com/agbossjs/agboss/issues/527). Not published to npm yet.

## What it will provide

| Contract                                       | How it maps to Redis                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| Execution leases (who moves a tree, by epoch)  | one Lua script per operation: compare the epoch, then set |
| Rate limits (concurrency, windows, breakers)   | Lua scripts / `MULTI` on counters with expiry             |
| The child queue (`ChildPlacement.AnyInstance`) | an atomic claim (Lua), each child claimed once            |

**Not provided, by design:** the fenced effect and the outbound-call store. Their guarantee — the
lease check and the business write in one transaction — needs a durable store holding both. Redis's
asynchronous replication can lose an acknowledged write on failover and roll a fencing epoch back.
#526's assembly check refuses a lease store on one backend with a fenced-effect or outbound-call
store on another, so an application that keeps its effects on PostgreSQL also keeps its leases
there. Redis serves the rate limits and the child queue next to that.

Every store will run `storeConformance` (#526) and the fault suite (#484) against a real Redis in
CI.

## Required database settings

`RedisConnection` checks the server at start (`CONFIG GET`) and refuses to start with
`RedisDurabilityError`, which names every setting found short:

| Setting                 | Required             | Why                                                                                                                                                                        |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendonly`            | `yes`                | without the append-only file a crash loses every write since the last RDB snapshot                                                                                         |
| `appendfsync`           | `always`             | `everysec` loses up to a second of acknowledged writes in a crash                                                                                                          |
| `CONFIG GET` permission | allowed for the user | a server whose settings cannot be read is not verified, so it is refused                                                                                                   |
| Failover                | **none** (operator)  | a replica promoted by Sentinel or a cluster failover may lack acknowledged writes; this one cannot be checked from the client — run one primary with no automatic failover |

```sh
redis-server --appendonly yes --appendfsync always
```

**The opt-out** names the guarantee given up, and accepts no other value:
`redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`. With it, a short server starts, and
`connection.durability()` reports `{ problems, optedOut: true }`. A crash can then lose a lease or a
rate-limit window that was acknowledged, and a second worker can take a tree the first still moves.

## The connection

```ts
import { Secret } from "@agboss/core";

export class AppEnvironment {
  redisUrl!: Secret; // redis://user:password@host:6379/0 — secret("REDIS_URL")
  redisDurabilityOptOut?: string; // only "acknowledged-writes-may-be-lost"
}
```

`RedisConnection` (`deps: [ApplicationContext]`, or `new RedisConnection({ url })` in a script or
a test) holds one [node-redis](https://github.com/redis/node-redis) client (`@redis/client`) per
application instance. At `onInit` it connects and runs the durability check. If the server is
down, the start fails after five quick retries instead of hanging. Once connected, a dropped
connection is retried indefinitely. `onDestroy` closes the client.

## Tests

```sh
npm ci && npm run pack:framework && npm run install:packed   # the core at the pinned SHA
npm run check                                                # the gate CI runs
```

The unit tests (settings, the durability check against a fake `CONFIG GET`, the URL, the reconnect
strategy) run anywhere. The integration tests need a durable Redis (`AGBOSS_REDIS_TEST_URL`) and
one with the defaults (`AGBOSS_REDIS_WEAK_TEST_URL`). Without them they are skipped locally with a
notice, and they fail in CI, which starts both (`redis:7`).

## License

Apache-2.0, as the core. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
