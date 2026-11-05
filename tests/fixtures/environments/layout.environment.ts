import { env, secret } from "@agboss/core";
import type { LayoutEnvironment } from "./layout.contract.js";

/** A layout of the tests: the test's Redis, a prefix and a SQLite file the test names. */
export const environment: LayoutEnvironment = {
  redisUrl: secret("AGBOSS_LAYOUT_REDIS_URL"),
  redisKeyPrefix: env("AGBOSS_LAYOUT_REDIS_PREFIX"),
  sqlitePath: env("AGBOSS_LAYOUT_SQLITE_PATH"),
  openRouterApiKey: secret("AGBOSS_LAYOUT_OPENROUTER_KEY"),
};
