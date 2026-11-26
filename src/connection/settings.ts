import { RedisSettingsError } from "../errors.js";
import type { RedisDurabilityOptOut } from "./durability.js";

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
   * Another value (0, 1, a negative or a fractional number) is a `RedisSettingsError` at construction
   * (agbossjs/agboss#1029), as in the driver.
   */
  readonly watchLivenessSeconds?: number;
}

/** The prefix of every key when the settings name none. */
export const DEFAULT_KEY_PREFIX = "agboss:";

/** The watch's liveness bound when the settings name none (agbossjs/agboss#789). */
export const DEFAULT_WATCH_LIVENESS_SECONDS = 10;

/**
 * `seconds` when the child queue's watch can run on it — a whole number of at least 2, as the
 * driver's option is checked —, else `RedisSettingsError` naming `watchLivenessSeconds`
 * (agbossjs/agboss#1029): a settings object a script or a provider builds is trusted no more than
 * the driver's options.
 */
export function checkedWatchLivenessOf(seconds: number | undefined): number | undefined {
  if (seconds === undefined || (Number.isInteger(seconds) && seconds >= 2)) return seconds;
  throw new RedisSettingsError({
    message: `watchLivenessSeconds must be a whole number of at least 2, got ${String(seconds)}`,
  });
}
