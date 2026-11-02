import { describe, expect, it } from "vitest";
import { keyOf, RedisScript, runScript, type ScriptClient } from "../../src/connection/scripts.js";

/**
 * agbossjs/agboss#693 — how a store runs its scripts: `EVALSHA` first; on `NOSCRIPT` (a restart or a
 * `SCRIPT FLUSH` dropped it — refused, nothing ran) the source once with `EVAL`; any other error
 * as it is, never run twice. A key is one JSON array of its parts, so no two part lists share one.
 */
const fakeClient = (evalSha: () => Promise<unknown>, evaluate: () => Promise<unknown>) => {
  const calls: string[] = [];
  const client: ScriptClient = {
    evalSha: async () => {
      calls.push("evalSha");
      return evalSha();
    },
    eval: async () => {
      calls.push("eval");
      return evaluate();
    },
  };
  return { client, calls };
};

describe("runScript", () => {
  const script = new RedisScript("return 1");

  it("names the script by its SHA-1", () => {
    expect(script.sha).toBe("e0e1f9fabfc9d4800c877a703b823ac0578ff8db");
  });

  it("EVALSHA answers: EVAL is never sent", async () => {
    const { client, calls } = fakeClient(
      async () => 1,
      async () => 2,
    );
    expect(await runScript(client, script, ["k"], ["a"])).toBe(1);
    expect(calls).toEqual(["evalSha"]);
  });

  it("NOSCRIPT: the source runs once with EVAL", async () => {
    const { client, calls } = fakeClient(
      async () => Promise.reject(new Error("NOSCRIPT No matching script.")),
      async () => 2,
    );
    expect(await runScript(client, script, [], [])).toBe(2);
    expect(calls).toEqual(["evalSha", "eval"]);
  });

  it("any other error is the call's, and nothing runs again", async () => {
    const { client, calls } = fakeClient(
      async () => Promise.reject(new Error("BUSY Redis is busy running a script")),
      async () => 2,
    );
    await expect(runScript(client, script, [], [])).rejects.toThrow(/^BUSY/u);
    expect(calls).toEqual(["evalSha"]);
  });
});

describe("keyOf", () => {
  it("one JSON array per part list: a separator inside a part makes no other key", () => {
    expect(keyOf("p:", "lease", "a:b", "c")).toBe('p:lease:["a:b","c"]');
    expect(keyOf("p:", "lease", "a", "b:c")).not.toBe(keyOf("p:", "lease", "a:b", "c"));
  });
});
