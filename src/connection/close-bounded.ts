import type { Clock } from "@agboss/core";
import { seconds } from "@agboss/core/units";

/**
 * How long a client's orderly close may take at an instance's stop before its socket is destroyed
 * (agbossjs/agboss#923): a quiet server never answers the `QUIT`, and the stop must end.
 */
export const CLOSE_GRACE = seconds(1);

/** The part of a node-redis client a close needs. */
export interface Closable {
  close(): Promise<unknown>;
  destroy(): void;
}

/** How a bounded close ended: in order, or by destroying a socket the server left unanswered. */
export enum CloseOutcome {
  Closed = "closed",
  Destroyed = "destroyed",
}

/**
 * Closes `client` in order (`QUIT`, the commands in flight answered); when that has not ended
 * within `CLOSE_GRACE` on `clock` — the server went quiet — destroys its socket: the commands in
 * flight reject, nothing is left open. A close that fails is ended too (no unhandled rejection).
 * Without a `clock` (a connection built by a script) the close is the orderly one only. The grace's
 * wait ends with the close: no timer is left behind.
 */
export async function closeBounded(
  client: Closable,
  clock: Clock | undefined,
): Promise<CloseOutcome> {
  const orderly = client.close().then(
    () => CloseOutcome.Closed,
    () => CloseOutcome.Closed,
  );
  if (clock === undefined) return orderly;
  const waiting = new AbortController();
  // once the close ended first, the aborted wait resolves into a race already decided
  const quiet = clock.sleep(CLOSE_GRACE, waiting.signal).then(() => CloseOutcome.Destroyed);
  try {
    const outcome = await Promise.race([orderly, quiet]);
    if (outcome === CloseOutcome.Destroyed) destroyed(client);
    return outcome;
  } finally {
    waiting.abort();
  }
}

/**
 * Destroys `client`'s socket whatever state it is in (agbossjs/agboss#954). A client that is
 * closing, or still connecting, is not `isOpen`, but its socket is up (or coming up): never
 * guarded by `isOpen`. A client already closed has nothing left to destroy.
 */
export function destroyed(client: Pick<Closable, "destroy">): void {
  try {
    client.destroy();
  } catch {
    // already closed: nothing left to destroy
  }
}
