import { RedisConnection, type RedisClient } from "../../src/index.js";

/** One script run a `scriptedConnection` saw: the script's name (its SHA-1 when none is given), its keys and its arguments. */
export interface ScriptRun {
  readonly script: string;
  readonly keys: readonly string[];
  readonly args: readonly string[];
}

/**
 * A connection whose client is the test's: every `EVALSHA` is answered by `reply` and recorded;
 * `exists` and `hGetAll` answer what the test stored. Never connected, so no server is needed — what
 * the scripts do on a server is the integration tests'.
 */
export function scriptedConnection(
  reply: (run: ScriptRun) => unknown,
  options: {
    keyPrefix?: string;
    exists?: number;
    /** What `GET` answers by key (absent: null). */
    values?: Record<string, string>;
    stored?: Record<string, string>;
    /** The scripts' names by their SHA-1. */
    names?: ReadonlyMap<string, string>;
  } = {},
): { connection: RedisConnection; runs: ScriptRun[] } {
  const runs: ScriptRun[] = [];
  const refused = (): Promise<never> => Promise.reject(new Error("not scripted"));
  const client: RedisClient = {
    evalSha: (sha, call) => {
      const run = { script: options.names?.get(sha) ?? sha, keys: call.keys, args: call.arguments };
      runs.push(run);
      return Promise.resolve(reply(run));
    },
    eval: refused,
    ping: () => Promise.resolve("PONG"),
    exists: () => Promise.resolve(options.exists ?? 0),
    get: (key) => Promise.resolve(options.values?.[key] ?? null),
    hGetAll: () => Promise.resolve(options.stored ?? {}),
    zRem: refused,
    del: refused,
  };
  const connection = new RedisConnection({
    url: "redis://127.0.0.1:1",
    keyPrefix: options.keyPrefix ?? "t:",
  });
  Object.defineProperty(connection, "client", { value: client });
  return { connection, runs };
}
