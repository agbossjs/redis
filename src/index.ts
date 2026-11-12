/**
 * `@agboss/redis` (agbossjs/agboss#527, #693): AGBoss's coordination stores on Redis — execution
 * leases, the child queue and rate limits shared by several application instances, on one durable
 * primary (`appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite no`,
 * `maxmemory-policy noeviction`; no replica, no cluster) checked at start. Threads, checkpoints,
 * fenced effects, outbound calls, pauses, records and the execution ids the leases hand out
 * (`provide(EXECUTION_ID_STORE, …)`) stay in PostgreSQL or MongoDB; the core's one-backend check
 * refuses a fenced-effect or outbound-call store of another backend beside these leases. List them
 * with `...REDIS_COORDINATION_STORES`.
 */
export { RedisConnection, type RedisClient } from "./connection/redis-connection.js";
export { DEFAULT_KEY_PREFIX, type RedisConnectionSettings } from "./connection/settings.js";
export { RedisDurabilityOptOut, type RedisDurability } from "./connection/durability.js";
export type { RedisTopology } from "./connection/deployment.js";
export {
  RedisDeploymentError,
  RedisDurabilityError,
  RedisLeaseKeyConflictError,
  type RedisLeaseKeyConflictErrorOptions,
  RedisSettingsError,
  type RedisProblemsOptions,
  type RedisSettingsErrorOptions,
} from "./errors.js";
export { RedisExecutionLeaseRepository } from "./stores/redis-execution-lease.repository.js";
export { RedisChildExecutionQueueRepository } from "./stores/redis-child-execution-queue.repository.js";
export { RedisRateLimitRepository } from "./stores/redis-rate-limit.repository.js";
export { REDIS_COORDINATION_STORES } from "./stores/coordination-stores.js";
