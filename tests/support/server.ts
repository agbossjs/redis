/**
 * The real servers of the integration tests. `AGBOSS_REDIS_TEST_URL` names a durable Redis (CI:
 * `redis:7 --appendonly yes --appendfsync always`); `AGBOSS_REDIS_WEAK_TEST_URL` a Redis with the
 * defaults (CI: a second `redis:7`, no AOF) — the start check must refuse it. Unset, the
 * integration tests are skipped locally (the global setup says so) and fail in CI.
 */
export const DURABLE_URL = process.env.AGBOSS_REDIS_TEST_URL ?? "";
export const WEAK_URL = process.env.AGBOSS_REDIS_WEAK_TEST_URL ?? "";

/** The variables and how to get the servers, as the setup's notice says. */
export const HOW_TO = `start a durable Redis and export its URL, e.g.
  docker run -d --name agboss-redis -p 6379:6379 redis:7 redis-server --appendonly yes --appendfsync always --maxmemory-policy noeviction
  export AGBOSS_REDIS_TEST_URL=redis://localhost:6379
and for the refusal, a Redis with the defaults (no append-only file):
  docker run -d --name agboss-redis-weak -p 6380:6379 redis:7
  export AGBOSS_REDIS_WEAK_TEST_URL=redis://localhost:6380
and for the replica refusal, a replica of the durable one:
  docker run -d --name agboss-redis-replica -p 6381:6379 redis:7 redis-server --replicaof host.docker.internal 6379
  export AGBOSS_REDIS_REPLICA_TEST_URL=redis://localhost:6381`;

/** A replica of the durable server (CI: `redis:7 --replicaof …`): the start check must refuse it. */
export const REPLICA_URL = process.env.AGBOSS_REDIS_REPLICA_TEST_URL ?? "";
