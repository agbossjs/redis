import type { Secret } from "@agboss/core";

/** The environment the stop tests' application reads: the Redis connection's fields, a SQLite file. */
export class StopEnvironment {
  redisUrl!: Secret;
  redisKeyPrefix?: string;
  sqlitePath!: string;
  /** The built-in model provider's key: a placeholder, the workflows call no model. */
  openRouterApiKey!: Secret;
}
