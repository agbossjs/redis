import { createHash } from "node:crypto";

/**
 * A Lua script of a store: every atomic operation of the Redis stores is one (agbossjs/agboss#693).
 * Redis runs a script to its end before any other command — no other client's command interleaves
 * with it — and replicates its effects, so a script may read `TIME` before it writes (Redis 7).
 * The stores declare every key they touch in `KEYS` except the child queue's claim, which finds the
 * claimed row from its queue entry: fine on one primary, the only deployment the connection
 * accepts (a cluster is refused at start).
 */
export class RedisScript {
  readonly sha: string;

  constructor(readonly source: string) {
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
 * A `NOSCRIPT` refusal runs nothing, so the script runs exactly once either way.
 */
export async function runScript(
  client: ScriptClient,
  script: RedisScript,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  const options = { keys: [...keys], arguments: [...args] };
  try {
    return await client.evalSha(script.sha, options);
  } catch (error) {
    if (!isNoScript(error)) throw error;
    return client.eval(script.source, options);
  }
}

/** The key of `kind` for `parts` under `prefix`: one JSON array, so no two part lists share one. */
export const keyOf = (prefix: string, kind: string, ...parts: readonly string[]): string =>
  `${prefix}${kind}:${JSON.stringify(parts)}`;
