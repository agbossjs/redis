/**
 * `@agboss/redis` (agbossjs/agboss#527, #693): AGBoss's coordination stores on Redis — execution
 * leases, the child queue and rate limits shared by several application instances, on one durable
 * primary (`appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite no`,
 * `maxmemory-policy noeviction`; no replica, no cluster) checked at start. Threads, checkpoints,
 * fenced effects, outbound calls, pauses, records and the kept execution ids stay in PostgreSQL or
 * MongoDB; the core's one-backend check refuses a fenced-effect or outbound-call store of another
 * backend beside these leases.
 */
export { RedisConnection, type RedisClient } from "./connection/redis-connection.js";
export { DEFAULT_KEY_PREFIX, type RedisConnectionSettings } from "./connection/settings.js";
export { RedisDurabilityOptOut, type RedisDurability } from "./connection/durability.js";
export { RedisDeploymentError, RedisDurabilityError, RedisSettingsError } from "./errors.js";
export {
  RedisExecutionLeaseRepository,
  type KeptExecutionIds,
} from "./stores/redis-execution-lease.repository.js";
export { RedisChildExecutionQueueRepository } from "./stores/redis-child-execution-queue.repository.js";
export { RedisRateLimitRepository } from "./stores/redis-rate-limit.repository.js";
