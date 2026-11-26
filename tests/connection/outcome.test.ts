import { StoreError, StoreOutcomeSource } from "@agboss/core/stores";
import type { Milliseconds } from "@agboss/core/units";
import {
  AbortError,
  BlobError,
  ClientClosedError,
  ClientOfflineError,
  CommandTimeoutDuringMaintenanceError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ErrorReply,
  MaxCommandRedirectionsError,
  MultiErrorReply,
  ReconnectStrategyError,
  RootNodesUnavailableError,
  SimpleError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutDuringMaintenanceError,
  SocketTimeoutError,
  TimeoutError,
} from "@redis/client";
import { describe, expect, it } from "vitest";
import { isKnown, outcomeOf, writing } from "../../src/connection/outcome.js";
import { RedisScript, runScript, type ScriptClient } from "../../src/connection/scripts.js";

/**
 * agbossjs/agboss#1017 — which errors of a Redis write leave its outcome unknown. The rule is a
 * whitelist: only an error that proves the command never ran is known (rethrown as it is); every
 * other error after the send, and every shape not recognised, is `StoreError.OutcomeUnknown`
 * (`source: Transport`, the driver's error the `cause`). A read keeps its own error. Each row
 * below is one entry of the whitelist or one error that must stay unknown.
 */

/** A Node system error as `net` / `dns` raise it. */
const systemError = (code: string, syscall: string): Error =>
  Object.assign(new Error(`${syscall} ${code}`), { code, syscall });

const reply = (message: string): ErrorReply => new SimpleError(message);

const SCRIPT_TAIL = " script: 5e6f, on @user_script:3.";

/** Never sent, or refused before the script ran: the command did nothing. */
const KNOWN: readonly (readonly [string, () => unknown])[] = [
  ["ClientOfflineError", () => new ClientOfflineError()],
  ["ClientClosedError", () => new ClientClosedError()],
  ["ConnectionTimeoutError (the connect timeout)", () => new ConnectionTimeoutError()],
  [
    "ReconnectStrategyError",
    () => new ReconnectStrategyError(new Error("gave up"), new Error("refused")),
  ],
  ["RootNodesUnavailableError", () => new RootNodesUnavailableError()],
  ["MaxCommandRedirectionsError", () => new MaxCommandRedirectionsError()],
  ["the queue is full", () => new Error("The queue is full")],
  ["NOSCRIPT", () => reply("NOSCRIPT No matching script. Please use EVAL.")],
  ["BUSY", () => reply("BUSY Redis is busy running a script.")],
  ["LOADING", () => reply("LOADING Redis is loading the dataset in memory")],
  ["READONLY", () => reply("READONLY You can't write against a read only replica.")],
  ["MASTERDOWN", () => reply("MASTERDOWN Link with MASTER is down")],
  ["NOAUTH", () => reply("NOAUTH Authentication required.")],
  ["NOPERM", () => reply("NOPERM User u has no permissions to run the 'evalsha' command")],
  ["CLUSTERDOWN", () => reply("CLUSTERDOWN The cluster is down")],
  ["NOREPLICAS", () => reply("NOREPLICAS Not enough good replicas to write.")],
  ["a blob reply of a refusal", () => new BlobError("BUSY Redis is busy running a script.")],
  ["ECONNREFUSED on connect", () => systemError("ECONNREFUSED", "connect")],
  ["ENOTFOUND on getaddrinfo", () => systemError("ENOTFOUND", "getaddrinfo")],
  ["EAI_AGAIN on getaddrinfo", () => systemError("EAI_AGAIN", "getaddrinfo")],
];

/** After the send, or of a shape not recognised: the command may have run. */
const UNKNOWN: readonly (readonly [string, () => unknown])[] = [
  ["SocketClosedUnexpectedlyError", () => new SocketClosedUnexpectedlyError()],
  ["ECONNRESET", () => systemError("ECONNRESET", "read")],
  ["EPIPE", () => systemError("EPIPE", "write")],
  ["ETIMEDOUT", () => systemError("ETIMEDOUT", "read")],
  ["ECONNABORTED", () => systemError("ECONNABORTED", "read")],
  ["ECONNRESET on connect", () => systemError("ECONNRESET", "connect")],
  ["ECONNREFUSED without a syscall", () => Object.assign(new Error("x"), { code: "ECONNREFUSED" })],
  ["connect without a code", () => Object.assign(new Error("x"), { syscall: "connect" })],
  [
    "a TLS error",
    () => Object.assign(new Error("bad record mac"), { code: "ERR_SSL_BAD_RECORD_MAC" }),
  ],
  [
    "a premature stream close",
    () => Object.assign(new Error("closed"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
  ],
  ["SocketTimeoutError (post-connect silence)", () => new SocketTimeoutError(1000)],
  ["SocketTimeoutDuringMaintenanceError", () => new SocketTimeoutDuringMaintenanceError(1000)],
  ["DisconnectsClientError", () => new DisconnectsClientError()],
  ["a command TimeoutError", () => new TimeoutError()],
  ["CommandTimeoutDuringMaintenanceError", () => new CommandTimeoutDuringMaintenanceError(5)],
  ["an AbortError (not told from a mid-flight one)", () => new AbortError()],
  ["OOM", () => reply("OOM command not allowed when used memory > 'maxmemory'." + SCRIPT_TAIL)],
  ["OOM before the script", () => reply("OOM command not allowed when used memory > 'maxmemory'.")],
  [
    "WRONGTYPE",
    () => reply("WRONGTYPE Operation against a key holding the wrong kind of value" + SCRIPT_TAIL),
  ],
  [
    "WRONGTYPE before the script's tail",
    () => reply("WRONGTYPE Operation against a key holding the wrong kind of value"),
  ],
  ["ERR from the script", () => reply("ERR Error running script" + SCRIPT_TAIL)],
  ["ERR", () => reply("ERR something")],
  ["a script error", () => reply("ERR user_script:3: boom")],
  ["BUSY inside the script", () => reply("BUSY something" + SCRIPT_TAIL)],
  ["NOPERM inside the script", () => reply("NOPERM no permissions to run 'set'" + SCRIPT_TAIL)],
  [
    "READONLY inside the script",
    () => reply("READONLY You can't write against a read only replica." + SCRIPT_TAIL),
  ],
  ["NOSCRIPT inside the script", () => reply("NOSCRIPT x" + SCRIPT_TAIL)],
  ["MultiErrorReply", () => new MultiErrorReply([reply("BUSY x")], [0])],
  [
    "a refusal word that is a prefix only",
    () => reply("BUSYGROUP Consumer Group name already exists"),
  ],
  ["a refusal word in lower case", () => reply("busy Redis is busy")],
  ["a refusal word after a space", () => reply(" BUSY Redis is busy")],
  ["a refusal word that is not a reply", () => new Error("BUSY Redis is busy running a script.")],
  ["the queue-full message with more text", () => new Error("The queue is full.")],
  ["a plain Error", () => new Error("boom")],
  ["a string", () => "BUSY"],
  ["null", () => null],
  ["an object of the right shape", () => ({ code: "ECONNREFUSED", syscall: "connect" })],
];

describe("isKnown: the whitelist", () => {
  it.each(KNOWN)("%s is known", (_name, make) => {
    expect(isKnown(make())).toBe(true);
  });

  it.each(UNKNOWN)("%s is not known", (_name, make) => {
    expect(isKnown(make())).toBe(false);
  });
});

describe("outcomeOf", () => {
  it.each(KNOWN)("%s: the error as it is", (_name, make) => {
    const error = make();
    expect(outcomeOf(error, "EVALSHA x")).toBe(error);
  });

  it.each(UNKNOWN)(
    "%s: StoreError.OutcomeUnknown from the transport, the error its cause",
    (_name, make) => {
      const error = make();
      const unknown = outcomeOf(error, "EVALSHA x");
      expect(unknown).toBeInstanceOf(StoreError.OutcomeUnknown);
      expect(unknown).toMatchObject({
        code: "store.outcome-unknown",
        store: "RedisConnection",
        operation: "EVALSHA x",
        source: StoreOutcomeSource.Transport,
        cause: error,
      });
    },
  );

  it("an error that already is of unknown outcome (a command timeout) passes through", () => {
    const timeout = new StoreError.CallTimeout({
      store: "RedisConnection",
      operation: "EVALSHA x",
      timeout: 5 as Milliseconds,
      source: StoreOutcomeSource.Command,
    });
    const unknown = new StoreError.OutcomeUnknown({
      store: "S",
      operation: "o",
      source: StoreOutcomeSource.Framework,
    });
    expect(outcomeOf(timeout, "EVALSHA y")).toBe(timeout);
    expect(outcomeOf(unknown, "EVALSHA y")).toBe(unknown);
  });
});

describe("writing", () => {
  it("the answer of a command that worked", async () => {
    expect(await writing("DEL", async () => 3)).toBe(3);
  });

  it.each(UNKNOWN)("%s: rejects as unknown, naming the command", async (_name, make) => {
    await expect(writing("DEL", () => rejected(make()))).rejects.toMatchObject({
      code: "store.outcome-unknown",
      operation: "DEL",
    });
  });

  it.each(KNOWN)("%s: rejects with its own error", async (_name, make) => {
    const error = make();
    await expect(writing("DEL", () => rejected(error))).rejects.toBe(error);
  });
});

/** A promise rejected with `value`, whatever it is (a driver may throw a string, an object). */
const rejected = (value: unknown): Promise<never> => {
  const rejections: ((reason: unknown) => void)[] = [];
  const promise = new Promise<never>((_, reject) => {
    rejections.push(reject);
  });
  rejections[0]?.(value);
  return promise;
};

/** A client whose `EVALSHA` fails with `make()` and whose `EVAL` never runs unless asked. */
const failing = (make: () => unknown): { client: ScriptClient; calls: string[] } => {
  const calls: string[] = [];
  const client: ScriptClient = {
    evalSha: async () => {
      calls.push("evalSha");
      return rejected(make());
    },
    eval: async () => {
      calls.push("eval");
      return rejected(make());
    },
  };
  return { client, calls };
};

describe("runScript: a write script is classified, a read script is not", () => {
  const write = new RedisScript("redis.call('SET', KEYS[1], 1)");
  const read = new RedisScript("return redis.call('GET', KEYS[1])", true);

  it("a script is a write unless it says it only reads", () => {
    expect(write.readOnly).toBe(false);
    expect(read.readOnly).toBe(true);
  });

  it.each(UNKNOWN)(
    "%s: a write script rejects as unknown, its operation the EVALSHA",
    async (_name, make) => {
      const { client } = failing(make);
      await expect(runScript(client, write, ["k"], [])).rejects.toMatchObject({
        code: "store.outcome-unknown",
        operation: `EVALSHA ${write.sha}`,
      });
    },
  );

  it.each(UNKNOWN)("%s: a read script keeps its own error", async (_name, make) => {
    const error = make();
    const { client } = failing(() => error);
    await expect(runScript(client, read, ["k"], [])).rejects.toBe(error);
  });

  it.each(KNOWN)("%s: a write script keeps its own error", async (_name, make) => {
    const error = make();
    const { client } = failing(() => error);
    await expect(runScript(client, write, ["k"], [])).rejects.toBe(error);
  });

  it("NOSCRIPT then a lost answer to EVAL: unknown, EVAL sent once", async () => {
    const calls: string[] = [];
    const client: ScriptClient = {
      evalSha: async () => {
        calls.push("evalSha");
        return Promise.reject(reply("NOSCRIPT No matching script."));
      },
      eval: async () => {
        calls.push("eval");
        return Promise.reject(new SocketClosedUnexpectedlyError());
      },
    };
    await expect(runScript(client, write, [], [])).rejects.toBeInstanceOf(
      StoreError.OutcomeUnknown,
    );
    expect(calls).toEqual(["evalSha", "eval"]);
  });

  it("a write script that worked answers as it did", async () => {
    const client: ScriptClient = { evalSha: async () => 7, eval: async () => 8 };
    expect(await runScript(client, write, [], [])).toBe(7);
  });
});
