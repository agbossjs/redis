import { requireServers } from "./global-setup.js";
import { DURABLE_URL } from "./server.js";

/**
 * The fault suite's setup: its pods run on the durable server only (CI's `faults` jobs start no
 * server with the defaults), so it requires that one alone — still never skipped in CI.
 */
export default async function requireDurableRedis(): Promise<void> {
  await requireServers([["AGBOSS_REDIS_TEST_URL", DURABLE_URL]]);
}
