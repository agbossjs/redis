import { describe, expect, it } from "vitest";
import { RedisDurabilityError, RedisDurabilityOptOut } from "../../src/index.js";
import {
  DURABILITY_PARAMETERS,
  durabilityProblemsOf,
  durabilityProblemsOfServer,
  requireDurability,
  type ConfigGet,
} from "../../src/connection/durability.js";

/** A fake `CONFIG GET` over `config`, recording what it was asked. */
function fakeConfigGet(config: Readonly<Record<string, string>>): {
  readonly configGet: ConfigGet;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const configGet: ConfigGet = async (parameter) => {
    asked.push(parameter);
    const value = config[parameter];
    return value === undefined ? {} : { [parameter]: value };
  };
  return { configGet, asked };
}

const DURABLE = {
  appendonly: "yes",
  appendfsync: "always",
  "no-appendfsync-on-rewrite": "no",
  "maxmemory-policy": "noeviction",
};

describe("durabilityProblemsOf: the server's settings", () => {
  it("appendonly yes and appendfsync always: durable", () => {
    expect(durabilityProblemsOf(DURABLE)).toEqual([]);
  });

  it("the values are compared without case", () => {
    expect(
      durabilityProblemsOf({
        ...DURABLE,
        appendonly: "YES",
        appendfsync: "Always",
        "maxmemory-policy": "NoEviction",
      }),
    ).toEqual([]);
  });

  it("appendonly no (Redis's default): every write since the last snapshot is lost", () => {
    expect(durabilityProblemsOf({ ...DURABLE, appendonly: "no" })).toEqual([
      expect.stringMatching(/^appendonly is no: .*since the last snapshot — set appendonly yes$/),
    ]);
  });

  it.each(["everysec", "no"])(
    "appendfsync %s: an acknowledged write is lost in a crash",
    (fsync) => {
      expect(durabilityProblemsOf({ ...DURABLE, appendfsync: fsync })).toEqual([
        expect.stringMatching(new RegExp(`^appendfsync is ${fsync}: .*set appendfsync always$`)),
      ]);
    },
  );

  it("Redis's defaults fail on both, in order", () => {
    const problems = durabilityProblemsOf({
      appendonly: "no",
      appendfsync: "everysec",
      "no-appendfsync-on-rewrite": "no",
      "maxmemory-policy": "noeviction",
    });

    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "appendonly is no",
      "appendfsync is everysec",
    ]);
  });

  it("a setting the server does not report is unset: a problem, never a pass", () => {
    expect(durabilityProblemsOf({})).toEqual([
      expect.stringMatching(/^appendonly is unset: /),
      expect.stringMatching(/^appendfsync is unset: /),
      expect.stringMatching(/^no-appendfsync-on-rewrite is unset: /),
      expect.stringMatching(/^maxmemory-policy is unset: /),
    ]);
  });

  it("no-appendfsync-on-rewrite yes: a rewrite's writes are acknowledged unsynced", () => {
    expect(durabilityProblemsOf({ ...DURABLE, "no-appendfsync-on-rewrite": "yes" })).toEqual([
      expect.stringMatching(
        /^no-appendfsync-on-rewrite is yes: .*without an fsync — set no-appendfsync-on-rewrite no$/,
      ),
    ]);
  });

  it.each(["allkeys-lru", "volatile-lru", "allkeys-random", "volatile-ttl", "allkeys-lfu"])(
    "maxmemory-policy %s: a lease key may be evicted and its epoch start again at 1",
    (policy) => {
      expect(durabilityProblemsOf({ ...DURABLE, "maxmemory-policy": policy })).toEqual([
        expect.stringMatching(
          new RegExp(
            `^maxmemory-policy is ${policy}: .*epoch starts again at 1 — set maxmemory-policy noeviction$`,
          ),
        ),
      ]);
    },
  );
});

describe("durabilityProblemsOfServer: CONFIG GET on the server", () => {
  it("asks for every durability setting and merges the replies", async () => {
    const { configGet, asked } = fakeConfigGet(DURABLE);

    expect(await durabilityProblemsOfServer(configGet)).toEqual([]);
    expect(asked).toEqual([...DURABILITY_PARAMETERS]);
    expect(DURABILITY_PARAMETERS).toEqual([
      "appendonly",
      "appendfsync",
      "no-appendfsync-on-rewrite",
      "maxmemory-policy",
    ]);
  });

  it("a weak server's replies give its problems", async () => {
    const { configGet } = fakeConfigGet({ ...DURABLE, appendfsync: "everysec" });

    expect(await durabilityProblemsOfServer(configGet)).toEqual([
      expect.stringMatching(/^appendfsync is everysec/),
    ]);
  });

  it("a server that refuses CONFIG GET cannot be verified: that is a problem", async () => {
    const refusing: ConfigGet = async () => {
      throw new Error("ERR unknown command 'CONFIG'");
    };

    expect(await durabilityProblemsOfServer(refusing)).toEqual([
      expect.stringMatching(
        /^CONFIG GET appendonly, appendfsync, no-appendfsync-on-rewrite, maxmemory-policy failed \(ERR unknown command 'CONFIG'\): the durability cannot be verified/,
      ),
    ]);
  });
});

describe("requireDurability: the start check's verdict", () => {
  it("no problem: durable, no opt-out used", () => {
    expect(requireDurability([], undefined)).toEqual({ problems: [], optedOut: false });
  });

  it("no problem with an opt-out set: the opt-out is not used", () => {
    expect(requireDurability([], RedisDurabilityOptOut.AcknowledgedWritesMayBeLost)).toEqual({
      problems: [],
      optedOut: false,
    });
  });

  it("problems without the opt-out: RedisDurabilityError naming each and the opt-out", () => {
    let thrown: unknown;
    try {
      requireDurability(["appendonly is no", "appendfsync is everysec"], undefined);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof RedisDurabilityError)) throw new Error("expected the named error");
    expect(thrown.problems).toEqual(["appendonly is no", "appendfsync is everysec"]);
    expect(thrown.message).toMatch(
      /can lose an acknowledged write — appendonly is no; appendfsync is everysec\. .*redisDurabilityOptOut: "acknowledged-writes-may-be-lost"$/,
    );
    expect(thrown.code).toBe("redis.durability-insufficient");
    expect(RedisDurabilityError.code).toBe("redis.durability-insufficient");
    expect(thrown.name).toBe("RedisDurabilityError");
  });

  it("problems with the opt-out: reported, not thrown — the loss accepted knowingly", () => {
    expect(
      requireDurability(["appendonly is no"], RedisDurabilityOptOut.AcknowledgedWritesMayBeLost),
    ).toEqual({ problems: ["appendonly is no"], optedOut: true });
  });
});
