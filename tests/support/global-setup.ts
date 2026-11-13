import { createClient } from "@redis/client";
import { pinnedUrl } from "./pinned-url.js";
import { DURABLE_URL, HOW_TO, WEAK_URL } from "./server.js";

/** The server variables the tests read (`server.ts`); each pinned by `pinServerUrls`. */
const SERVER_VARIABLES = [
  "AGBOSS_REDIS_TEST_URL",
  "AGBOSS_REDIS_WEAK_TEST_URL",
  "AGBOSS_REDIS_REPLICA_TEST_URL",
] as const;

/**
 * agbossjs/agboss#989: each server URL set, its host pinned to the address the server answers on,
 * so no test connection can be made to itself; the test files' workers start after the setup and
 * read the pinned URLs.
 */
async function pinServerUrls(): Promise<void> {
  for (const name of SERVER_VARIABLES) {
    const url = process.env[name];
    if (url !== undefined && url !== "") process.env[name] = await pinnedUrl(url, 6379);
  }
}

/**
 * The integration tests run against a real Redis. In CI (`CI` set) both URLs are required: a
 * missing one fails the run here, before any test — CI never skips them. Locally, without the
 * URLs, they are skipped and this says so; a URL that is set but does not answer fails the run.
 */
async function requireAnswer(name: string, url: string): Promise<void> {
  const client = createClient({ url, socket: { reconnectStrategy: false } });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw new Error(`${name} does not answer (${String(error)}) — ${HOW_TO}`);
  } finally {
    if (client.isOpen) await client.close();
  }
}

/**
 * Requires the given servers: in CI a missing URL fails the run before any test; locally it is
 * skipped with the notice; a URL that is set must answer.
 */
export async function requireServers(
  servers: readonly (readonly [name: string, url: string])[],
): Promise<void> {
  const missing = servers.filter(([, url]) => url === "").map(([name]) => name);
  if (missing.length > 0 && process.env.CI !== undefined && process.env.CI !== "")
    throw new Error(
      `${missing.join(" and ")} not set in CI: the integration tests never skip there — ${HOW_TO}`,
    );
  if (missing.length > 0)
    process.stderr.write(
      `\n[agboss-redis] ${missing.join(" and ")} not set: the integration tests against a real Redis are SKIPPED (they run in CI). To run them, ${HOW_TO}\n\n`,
    );
  await pinServerUrls();
  for (const [name, url] of servers)
    if (url !== "") await requireAnswer(name, process.env[name] ?? url);
}

export default async function requireRedis(): Promise<void> {
  await requireServers([
    ["AGBOSS_REDIS_TEST_URL", DURABLE_URL],
    ["AGBOSS_REDIS_WEAK_TEST_URL", WEAK_URL],
  ]);
}
