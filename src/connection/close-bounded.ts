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

/**
 * Closes `client` in order (`QUIT`, the commands in flight answered); when that has not ended
 * within `CLOSE_GRACE` on `clock` — the server went quiet — destroys its socket: the commands in
 * flight reject, nothing is left open. A close that fails afterwards is dropped (no unhandled
 * rejection). Without a `clock` (a connection built by a script) the close is the orderly one only.
 */
export async function closeBounded(client: Closable, clock: Clock | undefined): Promise<void> {
  const orderly = client.close().then(
    () => true,
    () => true,
  );
  if (clock === undefined) {
    await orderly;
    return;
  }
  const waiting = new AbortController();
  const quiet = clock.sleep(CLOSE_GRACE, waiting.signal).then(
    () => false,
    () => true,
  );
  try {
    if (!(await Promise.race([orderly, quiet]))) destroyed(client);
  } finally {
    waiting.abort();
  }
}

/** A client that is closing is not `isOpen` any more, but its socket is still up: destroy it. */
function destroyed(client: Closable): void {
  try {
    client.destroy();
  } catch {
    // already closed: nothing left to destroy
  }
}
