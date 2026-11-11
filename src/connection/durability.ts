import { RedisDurabilityError } from "../errors.js";

/**
 * The durability the coordination stores rest on. A lease's epoch, a rate-limit window, a queued
 * child are acknowledged to the caller; if the server loses one, a second worker can take a tree
 * the first still moves. Redis keeps an acknowledged write across a crash only with the
 * append-only file (`appendonly yes`) synced on every write (`appendfsync always`), during a
 * rewrite too (`no-appendfsync-on-rewrite no`), and keeps every key only when it never evicts one
 * (`maxmemory-policy noeviction`: a full server refuses writes instead of dropping a lease and
 * starting its epoch again at 1). It cannot keep a write across a failover to an asynchronous
 * replica — no setting fixes that; the README requires one durable primary and no automatic
 * failover, and `deployment.ts` refuses a replica and a cluster.
 */

/** The only opt-out: its value names the guarantee given up. */
export enum RedisDurabilityOptOut {
  /**
   * Start on a server that can lose an acknowledged write: no AOF, not fsynced on each write or
   * during a rewrite, or one that may evict keys.
   */
  AcknowledgedWritesMayBeLost = "acknowledged-writes-may-be-lost",
}

/** The server settings the check reads. */
export const DURABILITY_PARAMETERS = [
  "appendonly",
  "appendfsync",
  "no-appendfsync-on-rewrite",
  "maxmemory-policy",
] as const;

/**
 * What the server keeps of an acknowledged write (agbossjs/agboss#891: a report, it never throws):
 * each setting found short (empty when durable), and the opt-out that accepts the loss when one is
 * set (`redisDurabilityOptOut`) — `requireDurability()` refuses a short server without it.
 */
export interface RedisDurability {
  /** Each setting found short, with what it loses and what to set. Empty when durable. */
  readonly problems: readonly string[];
  /** The opt-out the connection was given, if any: the guarantee given up by name. */
  readonly optOut?: RedisDurabilityOptOut;
}

/** `CONFIG GET <parameter>`: `{ parameter: value }`, empty when the server has no such one. */
export type ConfigGet = (parameter: string) => Promise<Readonly<Record<string, string>>>;

const shown = (value: string | undefined): string => value ?? "unset";

/** One required setting: its name, the value it must have, and what is lost without it. */
interface Required {
  readonly name: (typeof DURABILITY_PARAMETERS)[number];
  readonly value: string;
  readonly loss: string;
}

const REQUIRED: readonly Required[] = [
  {
    name: "appendonly",
    value: "yes",
    loss: "without the append-only file a crash loses every write since the last snapshot",
  },
  {
    name: "appendfsync",
    value: "always",
    loss: "a write acknowledged before its fsync is lost in a crash",
  },
  {
    name: "no-appendfsync-on-rewrite",
    value: "no",
    loss: "during an AOF rewrite the writes are acknowledged without an fsync",
  },
  {
    name: "maxmemory-policy",
    value: "noeviction",
    loss: "under memory pressure the server may evict a lease key, and its fencing epoch starts again at 1",
  },
];

/** Each durability setting of `config` (`CONFIG GET` replies merged) that falls short, in order. */
export function durabilityProblemsOf(config: Readonly<Record<string, string>>): string[] {
  return REQUIRED.flatMap(({ name, value, loss }) => {
    const found = config[name]?.toLowerCase();
    return found === value ? [] : [`${name} is ${shown(found)}: ${loss} — set ${name} ${value}`];
  });
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
      `CONFIG GET ${DURABILITY_PARAMETERS.join(", ")} failed (${reason}): the durability cannot be verified — allow CONFIG GET for the stores' user`,
    ];
  }
}

/** The report of `problems` under `optOut`: the opt-out named only when one was given. */
export const durabilityOf = (
  problems: readonly string[],
  optOut: RedisDurabilityOptOut | undefined,
): RedisDurability => (optOut === undefined ? { problems } : { problems, optOut });

/**
 * The start check's verdict: durable → nothing; short → `RedisDurabilityError` naming each problem,
 * unless the report's `optOut` accepts the loss.
 */
export function requireDurable(durability: RedisDurability): void {
  if (durability.problems.length > 0 && durability.optOut === undefined)
    throw new RedisDurabilityError({ problems: durability.problems });
}
