import { createHash } from "node:crypto";
import { writing } from "./outcome.js";

/**
 * A Lua script of a store: every atomic operation of the Redis stores is one (agbossjs/agboss#693).
 * Redis runs a script to its end before any other command — no other client's command interleaves
 * with it — and replicates its effects, so a script may read `TIME` before it writes (Redis 7).
 * The stores declare every key they touch in `KEYS` except the child queue's claim, which finds the
 * claimed row from its queue entry: fine on one primary, the only deployment the connection
 * accepts (a cluster is refused at start). A script that only reads (`readOnly`) fails with the
 * driver's own error; any other is a write, whose failure after the send is of unknown outcome
 * (`outcome.ts`, agbossjs/agboss#1017).
 *
 * Invariant of every script of the stores: it never raises or returns an error reply of its own
 * (`redis.error_reply(...)`, `return { err = ... }`) whose text starts with a word of
 * `REFUSED_BEFORE_RUN` (`NOSCRIPT`, `BUSY`, `LOADING`, `READONLY`, `MASTERDOWN`, `NOAUTH`, `NOPERM`,
 * `CLUSTERDOWN`, `NOREPLICAS`), and never builds such a reply from a variable. `outcome.ts` reads an
 * `ErrorReply` that starts with one of those words and lacks the `@user_script` suffix the server
 * appends to the errors of `redis.call` as a refusal BEFORE the script ran (known, the step fails): a
 * script's own reply carries no such suffix, so one starting with the word, sent after a write, would
 * read as known although the write was applied. `tests/connection/script-replies.test.ts` scans
 * the sources of `src/stores` and fails on any.
 */
export class RedisScript {
  readonly sha: string;

  constructor(
    readonly source: string,
    readonly readOnly = false,
  ) {
    this.sha = createHash("sha1").update(source).digest("hex");
  }
}

/** What a script needs of the client: `EVALSHA` and `EVAL` with their keys and arguments. */
export interface ScriptClient {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(source: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/** Whether `error` is the server's "no such script" (a restart or `SCRIPT FLUSH` dropped it). */
const isNoScript = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("NOSCRIPT");

/**
 * Runs `script` with `keys` and `args`: `EVALSHA`, and on `NOSCRIPT` the source once with `EVAL`.
 * A `NOSCRIPT` refusal runs nothing, so the script runs exactly once either way. A write script's
 * error after the send is read by the whitelist of `outcome.ts`.
 */
export function runScript(
  client: ScriptClient,
  script: RedisScript,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  const options = { keys: [...keys], arguments: [...args] };
  const run = async (): Promise<unknown> => {
    try {
      return await client.evalSha(script.sha, options);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return client.eval(script.source, options);
    }
  };
  return script.readOnly ? run() : writing(`EVALSHA ${script.sha}`, run);
}

/** The key of `kind` for `parts` under `prefix`: one JSON array, so no two part lists share one. */
export const keyOf = (prefix: string, kind: string, ...parts: readonly string[]): string =>
  `${prefix}${kind}:${JSON.stringify(parts)}`;
