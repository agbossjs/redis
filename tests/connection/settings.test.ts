import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  RedisSettingsError,
} from "../../src/index.js";

describe("the settings of the Redis stores", () => {
  it("the defaults a driver without the option leaves: the prefix and the watch's bound", () => {
    expect(DEFAULT_KEY_PREFIX).toBe("agboss:");
    expect(DEFAULT_WATCH_LIVENESS_SECONDS).toBe(10);
  });

  it("the error has its stable code", () => {
    expect(RedisSettingsError.code).toBe("redis.settings-invalid");
  });
});
