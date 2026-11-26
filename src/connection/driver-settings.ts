import type { DriverTimeouts, ResolvedSettings } from "@agboss/core/stores";
import { z } from "zod";
import { RedisSettingsError } from "../errors.js";
import { RedisDurabilityOptOut } from "./durability.js";
import { checkedWatchLivenessOf, type RedisConnectionSettings } from "./settings.js";

/**
 * The settings `RedisDriver` resolved (agbossjs/agboss#1321f): its options with the `secret(…)` of
 * the URL revealed and the watch's liveness in `Milliseconds` (`DriverTimeouts`), read once at
 * start. What `RedisConnection` makes its client of.
 */

/** A `Secret` of the resolved settings: only `reveal()` gives its value. */
const Revealing = z.custom<{ reveal(): string }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "reveal" in value &&
    typeof value.reveal === "function",
  { message: "the driver's url must be a secret(…)" },
);

const Resolved = z.object({
  kind: z.literal("redis"),
  url: Revealing,
  keyPrefix: z
    .string()
    .min(1, { message: "keyPrefix is empty: leave it unset for agboss:" })
    .optional(),
  durabilityOptOut: z
    .enum(RedisDurabilityOptOut, {
      message: `durabilityOptOut must be exactly "${RedisDurabilityOptOut.AcknowledgedWritesMayBeLost}": the opt-out names the guarantee it gives up`,
    })
    .optional(),
  watchLiveness: z.number().optional(),
});

/** What a driver's `timeouts` hold, as settings fields: the watch's liveness only (Redis has no transaction or command timeout). */
export const timeoutSettingsOf = (
  timeouts: Pick<DriverTimeouts, "watchLiveness"> | undefined,
): Record<string, number> =>
  timeouts?.watchLiveness === undefined ? {} : { watchLiveness: timeouts.watchLiveness };

/** The connection settings of a driver's resolved settings; `RedisSettingsError` for one that is none. */
export function settingsOfResolved(resolved: ResolvedSettings): RedisConnectionSettings {
  const parsed = Resolved.safeParse(resolved);
  if (!parsed.success)
    throw new RedisSettingsError({
      message: `the Redis driver's settings are wrong — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    });
  const { url: secret, keyPrefix, durabilityOptOut, watchLiveness } = parsed.data;
  const url = secret.reveal();
  if (url.length === 0) throw new RedisSettingsError({ message: "the driver's url is empty" });
  const watchLivenessSeconds = checkedWatchLivenessOf(
    watchLiveness === undefined ? undefined : watchLiveness / 1000,
  );
  return {
    url,
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
    ...(durabilityOptOut === undefined ? {} : { durabilityOptOut }),
    ...(watchLivenessSeconds === undefined ? {} : { watchLivenessSeconds }),
  };
}
