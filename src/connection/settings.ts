import { z } from "zod";
import { RedisSettingsError } from "../errors.js";
import { RedisDurabilityOptOut } from "./durability.js";

/** What one application instance's connection is made of. */
export interface RedisConnectionSettings {
  /** The server: `redis://user:password@host:6379/0` (or `rediss://` for TLS). */
  readonly url: string;
  /** Start on a server that can lose an acknowledged write — the opt-out names that loss. */
  readonly durabilityOptOut?: RedisDurabilityOptOut;
  /**
   * What every key of the stores starts with (default `agboss:`): several applications, or the
   * tests' files, share one server without seeing each other's keys.
   */
  readonly keyPrefix?: string;
  /**
   * The longest a silently dead connection of the child queue's watch (a half-open TCP connection:
   * no FIN, no RST) goes unnoticed, in seconds (agbossjs/agboss#789; default
   * `DEFAULT_WATCH_LIVENESS_SECONDS`, 10, at least 2): the watch pings its connection every half of
   * it and gives the answer the other half, then warns, subscribes on a new connection and wakes
   * once.
   */
  readonly watchLivenessSeconds?: number;
}

/** The prefix of every key when the settings name none. */
export const DEFAULT_KEY_PREFIX = "agboss:";

/** The watch's liveness bound when the settings name none (agbossjs/agboss#789). */
export const DEFAULT_WATCH_LIVENESS_SECONDS = 10;

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
  redisKeyPrefix: z
    .string()
    .min(1, { message: "redisKeyPrefix is empty: leave it unset for the default agboss:" })
    .optional(),
  redisWatchLivenessSeconds: z
    .number({ message: "redisWatchLivenessSeconds must be a number" })
    .int("redisWatchLivenessSeconds must be a whole number")
    .min(2, "redisWatchLivenessSeconds must be at least 2")
    .optional(),
});

const MISSING_URL =
  'redisUrl is missing: declare redisUrl!: Secret in the environment contract and set redisUrl: secret("REDIS_URL")';

/**
 * The connection settings an application's environment gives: `redisUrl` (required, a `Secret`),
 * `redisDurabilityOptOut`, `redisKeyPrefix` and `redisWatchLivenessSeconds` (optional). A missing or mistyped field fails with
 * `RedisSettingsError`, naming it — the URL itself is never printed.
 */
export function settingsOfEnvironment(environment: unknown): RedisConnectionSettings {
  const parsed = RedisEnvironment.safeParse(environment);
  if (!parsed.success) {
    const isUrlMissing = Reflect.get(Object(environment), "redisUrl") === undefined;
    const problems = parsed.error.issues.map((issue) =>
      issue.path[0] === "redisUrl" && isUrlMissing ? MISSING_URL : issue.message,
    );
    throw new RedisSettingsError({
      message: `the Redis stores need their environment fields — ${problems.join("; ")}`,
    });
  }
  const { redisUrl, redisDurabilityOptOut, redisKeyPrefix } = parsed.data;
  const { redisWatchLivenessSeconds } = parsed.data;
  const url = redisUrl.reveal();
  if (url.length === 0) throw new RedisSettingsError({ message: "redisUrl is empty" });
  return {
    url,
    durabilityOptOut: redisDurabilityOptOut,
    ...(redisKeyPrefix === undefined ? {} : { keyPrefix: redisKeyPrefix }),
    ...(redisWatchLivenessSeconds === undefined
      ? {}
      : { watchLivenessSeconds: redisWatchLivenessSeconds }),
  };
}
