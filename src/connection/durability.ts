import { RedisDurabilityError } from "../errors.js";

/**
 * The durability the coordination stores rest on. A lease's epoch, a rate-limit window, a queued
 * child are acknowledged to the caller; if the server loses one in a crash, a second worker can
 * take a tree the first still moves. Redis keeps an acknowledged write across a crash only with
 * the append-only file (`appendonly yes`) synced on every write (`appendfsync always`). It cannot
 * keep it across a failover to an asynchronous replica — no setting here fixes that; the README
 * requires a deployment without automatic failover.
 */

/** The only opt-out: its value names the guarantee given up. */
export enum RedisDurabilityOptOut {
  /** Start on a server that can lose an acknowledged write (no AOF, or not fsynced each write). */
  AcknowledgedWritesMayBeLost = "acknowledged-writes-may-be-lost",
}

/** The server settings the check reads. */
export const DURABILITY_PARAMETERS = ["appendonly", "appendfsync"] as const;

/** What the start check found: the problems (empty when durable), and whether they were accepted. */
export interface RedisDurability {
  readonly problems: readonly string[];
  /** True when the server is short and `redisDurabilityOptOut` accepted it. */
  readonly optedOut: boolean;
}

/** `CONFIG GET <parameter>`: `{ parameter: value }`, empty when the server has no such one. */
export type ConfigGet = (parameter: string) => Promise<Readonly<Record<string, string>>>;

const shown = (value: string | undefined): string => value ?? "unset";

/** Each durability setting of `config` (`CONFIG GET` replies merged) that falls short. */
export function durabilityProblemsOf(config: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const appendonly = config.appendonly?.toLowerCase();
  if (appendonly !== "yes")
    problems.push(
      `appendonly is ${shown(appendonly)}: without the append-only file a crash loses every write since the last snapshot — set appendonly yes`,
    );
  const appendfsync = config.appendfsync?.toLowerCase();
  if (appendfsync !== "always")
    problems.push(
      `appendfsync is ${shown(appendfsync)}: a write acknowledged before its fsync is lost in a crash — set appendfsync always`,
    );
  return problems;
}

/**
 * The durability problems of the server `configGet` asks. A server that refuses `CONFIG GET`
 * (a managed Redis that disables it) cannot be verified: that is a problem too, never a pass.
 */
export async function durabilityProblemsOfServer(configGet: ConfigGet): Promise<string[]> {
  try {
    const replies = await Promise.all(DURABILITY_PARAMETERS.map((name) => configGet(name)));
    return durabilityProblemsOf(
      Object.fromEntries(replies.flatMap((reply) => Object.entries(reply))),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      `CONFIG GET appendonly/appendfsync failed (${reason}): the durability cannot be verified — allow CONFIG GET for the stores' user`,
    ];
  }
}

/**
 * The start check's verdict: durable → no problem; short → `RedisDurabilityError` naming each
 * problem, unless `optOut` accepts the loss (then the problems are reported, not thrown).
 */
export function requireDurability(
  problems: readonly string[],
  optOut: RedisDurabilityOptOut | undefined,
): RedisDurability {
  if (problems.length === 0) return { problems, optedOut: false };
  if (optOut === undefined) throw new RedisDurabilityError(problems);
  return { problems, optedOut: true };
}
