import { env, secret } from "@agboss/core";
import type { StopEnvironment } from "./stop.contract.js";

/** The stop tests' server, a prefix and a SQLite file the test names. */
export const environment: StopEnvironment = {
  redisUrl: secret("AGBOSS_STOP_REDIS_URL"),
  redisKeyPrefix: env("AGBOSS_STOP_REDIS_PREFIX"),
  sqlitePath: env("AGBOSS_STOP_SQLITE_PATH"),
  openRouterApiKey: secret("AGBOSS_STOP_OPENROUTER_KEY"),
};
