import { describe, expect, it } from "vitest";
import { RedisDurabilityOptOut, RedisSettingsError } from "../../src/index.js";
import { settingsOfEnvironment } from "../../src/connection/settings.js";
import { revealing } from "../support/application-context.js";

const URL = "redis://app:secret@cache:6379/0";

describe("the environment fields of the Redis stores", () => {
  it("redisUrl is a Secret: its revealed value is the URL; the opt-out is optional", () => {
    expect(settingsOfEnvironment({ redisUrl: revealing(URL) })).toEqual({
      url: URL,
      durabilityOptOut: undefined,
    });
  });

  it("redisDurabilityOptOut is read when it names the lost guarantee exactly", () => {
    const settings = settingsOfEnvironment({
      redisUrl: revealing(URL),
      redisDurabilityOptOut: "acknowledged-writes-may-be-lost",
    });

    expect(settings.durabilityOptOut).toBe(RedisDurabilityOptOut.AcknowledgedWritesMayBeLost);
  });

  it.each(["yes", "true", "skip", "ACKNOWLEDGED-WRITES-MAY-BE-LOST", ""])(
    "an opt-out that does not name the guarantee (%o) fails: no vague opt-out",
    (value) => {
      expect(() =>
        settingsOfEnvironment({ redisUrl: revealing(URL), redisDurabilityOptOut: value }),
      ).toThrow(/redisDurabilityOptOut must be exactly "acknowledged-writes-may-be-lost"/);
    },
  );

  it("a flag is not an opt-out either", () => {
    expect(() =>
      settingsOfEnvironment({ redisUrl: revealing(URL), redisDurabilityOptOut: true }),
    ).toThrow(RedisSettingsError);
  });

  it("a missing redisUrl fails, naming the field and how to declare it", () => {
    expect(() => settingsOfEnvironment({})).toThrow(RedisSettingsError);
    expect(() => settingsOfEnvironment({})).toThrow(
      /redisUrl is missing: declare redisUrl!: Secret/,
    );
  });

  it("an environment that is not an object fails with the named error", () => {
    expect(() => settingsOfEnvironment(undefined)).toThrow(RedisSettingsError);
    expect(() => settingsOfEnvironment(undefined)).toThrow(/need their environment fields/);
  });

  it("a redisUrl that is a plain string, not a Secret, fails without printing it", () => {
    const failure = (): unknown => settingsOfEnvironment({ redisUrl: URL });

    expect(failure).toThrow(/redisUrl must be a Secret/);
    expect(failure).not.toThrow(/secret@cache/);
  });

  it("an empty redisUrl fails", () => {
    expect(() => settingsOfEnvironment({ redisUrl: revealing("") })).toThrow("redisUrl is empty");
  });

  it("every problem is listed at once", () => {
    expect(() => settingsOfEnvironment({ redisDurabilityOptOut: "yes" })).toThrow(
      /redisUrl is missing.*redisDurabilityOptOut must be exactly/,
    );
  });

  it("the error has its stable code", () => {
    expect(RedisSettingsError.code).toBe("redis.settings-invalid");
  });
});
