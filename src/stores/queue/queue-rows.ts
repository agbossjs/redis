import { ChildPlacement, ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { z } from "zod";
import { keyOf } from "../../connection/scripts.js";
import { QUEUED_AT_DIGITS } from "./queue-scripts.js";

/** How the queue's rows and members are written and read back (agbossjs/agboss#693, #1286). */

/** A time as the row keeps it: ms as text. */
const Time = z
  .string()
  .regex(/^-?\d+$/u)
  .transform((text) => new Date(Number(text)));

const Row = z.object({
  tenantId: z.string(),
  executionId: z.string(),
  rootExecutionId: z.string(),
  parentExecutionId: z.string(),
  rootWorkflow: z.string(),
  workflow: z.string(),
  depth: z.string().transform(Number).pipe(z.number().int()),
  status: z.enum(ExecutionRecordStatus),
  run: z.string(),
  queuedAt: Time,
  instanceId: z.string().optional(),
  claimedAt: Time.optional(),
  endedAt: Time.optional(),
  failure: z.string().optional(),
  placement: z.enum(ChildPlacement).optional(),
  excludeInstanceId: z.string().optional(),
});

/** A row as the contract gives it back. */
export const childOf = (
  fields: Readonly<Record<string, string | undefined>>,
): QueuedChildExecution => {
  const row = Row.parse(fields);
  return {
    ...row,
    instanceId: row.instanceId,
    claimedAt: row.claimedAt,
    endedAt: row.endedAt,
    failure: row.failure,
  };
};

/** A flat `HGETALL` reply (name, value, …) as fields: each name at an even place, its value after it. */
export const fieldsOf = (reply: unknown): Record<string, string | undefined> => {
  const flat = z.array(z.string()).parse(reply);
  return Object.fromEntries(
    flat.flatMap((name, at) => (at % 2 === 0 ? [[name, flat[at + 1]]] : [])),
  );
};

/** A list of rows, each a flat `HGETALL` reply: the children as the contract gives them back. */
export const rowsOf = (reply: unknown): QueuedChildExecution[] =>
  z
    .array(z.array(z.string()))
    .parse(reply)
    .map((row) => childOf(fieldsOf(row)));

/** The queue member's time part: `queuedAt` shifted to be positive, 17 digits — sorts by time. */
export const queuedAtText = (queuedAt: Date): string =>
  String(queuedAt.getTime() + 8.64e15).padStart(QUEUED_AT_DIGITS, "0");

/** A queue member's `queuedAt`: its time part shifted back. */
export const queuedAtOf = (member: string): Date =>
  new Date(Number(member.slice(0, QUEUED_AT_DIGITS)) - 8.64e15);

/** The depth script's reply: the queued count, the running count, the oldest queued member or nil. */
export const DepthReply = z.tuple([z.number().int(), z.number().int(), z.string().nullable()]);

/** The keys of the queue under a connection's prefix. */
export interface QueueKeys {
  /** A child's row: one hash. */
  row(tenantId: string, executionId: string): string;
  /** The rows' common prefix: a queue member's id is appended to it. */
  readonly rowPrefix: string;
  /** The general queue, or the isolated workers' (#1286b): a child is on exactly one. */
  queue(isIsolated: boolean): string;
  /** Every queued member by time alone: the depth's count and its oldest. */
  readonly byTime: string;
  /** The running rows. */
  readonly running: string;
  /** A tree's children: one set of row ids. */
  tree(tree: Pick<QueuedChildExecution, "tenantId" | "rootExecutionId">): string;
  /** What every save publishes on. */
  readonly channel: string;
}

/** The keys of the queue under `prefix`. */
export const queueKeysOf = (prefix: string): QueueKeys => ({
  row: (tenantId, executionId) => keyOf(prefix, "child", tenantId, executionId),
  rowPrefix: `${prefix}child:`,
  queue: (isIsolated) => `${prefix}${isIsolated ? "children-queued-isolated" : "children-queued"}`,
  byTime: `${prefix}children-queued-by-time`,
  running: `${prefix}children-running`,
  tree: (tree) => keyOf(prefix, "children-of", tree.tenantId, tree.rootExecutionId),
  channel: `${prefix}child-queued`,
});
