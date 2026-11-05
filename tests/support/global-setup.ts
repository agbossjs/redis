import { createClient } from "@redis/client";
import { DURABLE_URL, HOW_TO, WEAK_URL } from "./server.js";

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
  for (const [name, url] of servers) if (url !== "") await requireAnswer(name, url);
}

export default async function requireRedis(): Promise<void> {
  await requireServers([
    ["AGBOSS_REDIS_TEST_URL", DURABLE_URL],
    ["AGBOSS_REDIS_WEAK_TEST_URL", WEAK_URL],
  ]);
}
