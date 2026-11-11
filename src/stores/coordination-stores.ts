import { RedisChildExecutionQueueRepository } from "./redis-child-execution-queue.repository.js";
import { RedisExecutionLeaseRepository } from "./redis-execution-lease.repository.js";
import { RedisRateLimitRepository } from "./redis-rate-limit.repository.js";

/**
 * Every store of `@agboss/redis` (agbossjs/agboss#891), to spread into `@Application({ providers
 * })`: the coordination stores — leases, the child queue, rate limits. The rest of the application
 * stays on a durable backend: its `POSTGRES_DURABLE_STORES` / `MONGODB_DURABLE_STORES` (no lease,
 * queue, rate-limit, fenced-effect or outbound-call store), and the ids these leases hand out under
 * `provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)` (or Mongo's). `agboss describe`
 * still names each store.
 */
export const REDIS_COORDINATION_STORES = [
  RedisExecutionLeaseRepository,
  RedisChildExecutionQueueRepository,
  RedisRateLimitRepository,
] as const;
