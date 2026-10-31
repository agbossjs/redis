import { z } from "zod";
import { RedisSettingsError } from "../errors.js";
import { RedisDurabilityOptOut } from "./durability.js";

/** What one application instance's connection is made of. */
export interface RedisConnectionSettings {
  /** The server: `redis://user:password@host:6379/0` (or `rediss://` for TLS). */
  readonly url: string;
  /** Start on a server that can lose an acknowledged write — the opt-out names that loss. */
  readonly durabilityOptOut?: RedisDurabilityOptOut;
}

/** A `Secret` of the environment: only `reveal()` gives its value. */
interface RevealedSecret {
  reveal(): string;
}

const isSecret = (value: unknown): value is RevealedSecret =>
  typeof value === "object" &&
  value !== null &&
  "reveal" in value &&
  typeof value.reveal === "function";

/** The fields the Redis stores read from the application's environment. */
const RedisEnvironment = z.object({
  redisUrl: z.custom<RevealedSecret>(isSecret, {
    message: 'redisUrl must be a Secret: redisUrl: secret("REDIS_URL")',
  }),
  redisDurabilityOptOut: z
    .enum(RedisDurabilityOptOut, {
      message: `redisDurabilityOptOut must be exactly "${RedisDurabilityOptOut.AcknowledgedWritesMayBeLost}": the opt-out names the guarantee it gives up`,
    })
    .optional(),
});

const MISSING_URL =
  'redisUrl is missing: declare redisUrl!: Secret in the environment contract and set redisUrl: secret("REDIS_URL")';

/**
 * The connection settings an application's environment gives: `redisUrl` (required, a `Secret`)
 * and `redisDurabilityOptOut` (optional). A missing or mistyped field fails with
 * `RedisSettingsError`, naming it — the URL itself is never printed.
 */
export function settingsOfEnvironment(environment: unknown): RedisConnectionSettings {
  const parsed = RedisEnvironment.safeParse(environment);
  if (!parsed.success) {
    const isUrlMissing = Reflect.get(Object(environment), "redisUrl") === undefined;
    const problems = parsed.error.issues.map((issue) =>
      issue.path[0] === "redisUrl" && isUrlMissing ? MISSING_URL : issue.message,
    );
    throw new RedisSettingsError(
      `the Redis stores need their environment fields — ${problems.join("; ")}`,
    );
  }
  const { redisUrl, redisDurabilityOptOut } = parsed.data;
  const url = redisUrl.reveal();
  if (url.length === 0) throw new RedisSettingsError("redisUrl is empty");
  return { url, durabilityOptOut: redisDurabilityOptOut };
}
