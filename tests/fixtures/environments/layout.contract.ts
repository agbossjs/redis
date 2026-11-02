import type { Secret } from "@agboss/core";

/** The environment the layouts read: the Redis connection's fields and a SQLite file. */
export class LayoutEnvironment {
  redisUrl!: Secret;
  redisKeyPrefix?: string;
  sqlitePath!: string;
  /** The built-in model provider's key: a placeholder, the echo workflow calls no model. */
  openRouterApiKey!: Secret;
}
