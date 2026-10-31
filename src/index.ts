/**
 * `@agboss/redis` (agbossjs/agboss#527): AGBoss's coordination stores on Redis — scaffold. The
 * connection is here: one node-redis client per application instance, refused at start on a server
 * that can lose an acknowledged write (`appendonly yes`, `appendfsync always` required) unless the
 * opt-out names that loss. The stores — leases, rate limits, the child queue — follow the core's
 * store conformance (agbossjs/agboss#526) and fault suite (#484); fenced effects and outbound calls
 * stay on a durable store.
 */
export { RedisConnection, type RedisClient } from "./connection/redis-connection.js";
export type { RedisConnectionSettings } from "./connection/settings.js";
export { RedisDurabilityOptOut, type RedisDurability } from "./connection/durability.js";
export { RedisDurabilityError, RedisSettingsError } from "./errors.js";
