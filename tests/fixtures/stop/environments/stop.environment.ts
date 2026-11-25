import type { EmptyEnvironment } from "@agboss/core";

/**
 * The stop tests' application settings: none — its Redis (`AGBOSS_STOP_REDIS_URL`) and its SQLite
 * file (`AGBOSS_STOP_SQLITE_PATH`), named by the test, are references its storages read from the
 * process when it starts.
 */
export const environment: EmptyEnvironment = {};
