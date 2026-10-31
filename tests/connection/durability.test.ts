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

const DURABLE = { appendonly: "yes", appendfsync: "always" };

describe("durabilityProblemsOf: the server's settings", () => {
  it("appendonly yes and appendfsync always: durable", () => {
    expect(durabilityProblemsOf(DURABLE)).toEqual([]);
  });

  it("the values are compared without case", () => {
    expect(durabilityProblemsOf({ appendonly: "YES", appendfsync: "Always" })).toEqual([]);
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
    const problems = durabilityProblemsOf({ appendonly: "no", appendfsync: "everysec" });

    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "appendonly is no",
      "appendfsync is everysec",
    ]);
  });

  it("a setting the server does not report is unset: a problem, never a pass", () => {
    expect(durabilityProblemsOf({})).toEqual([
      expect.stringMatching(/^appendonly is unset: /),
      expect.stringMatching(/^appendfsync is unset: /),
    ]);
  });
});

describe("durabilityProblemsOfServer: CONFIG GET on the server", () => {
  it("asks for appendonly and appendfsync and merges the replies", async () => {
    const { configGet, asked } = fakeConfigGet(DURABLE);

    expect(await durabilityProblemsOfServer(configGet)).toEqual([]);
    expect(asked).toEqual([...DURABILITY_PARAMETERS]);
    expect(DURABILITY_PARAMETERS).toEqual(["appendonly", "appendfsync"]);
  });

  it("a weak server's replies give its problems", async () => {
    const { configGet } = fakeConfigGet({ appendonly: "yes", appendfsync: "everysec" });

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
        /^CONFIG GET appendonly\/appendfsync failed \(ERR unknown command 'CONFIG'\): the durability cannot be verified/,
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
