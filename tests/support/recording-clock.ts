import { VirtualClock } from "@agboss/core/testing";
import type { Milliseconds } from "@agboss/core/units";

/** One `sleep` a test clock was asked for: how long, the signal that may end it, whether it ended. */
export interface RecordedSleep {
  readonly delay: Milliseconds;
  readonly signal: AbortSignal | undefined;
  readonly isEnded: boolean;
}

/**
 * A `VirtualClock` that records every `sleep` (agbossjs/agboss#1213): a test sees which waits are
 * still running — one nobody ends is a timer left behind.
 */
export class RecordingClock extends VirtualClock {
  readonly #sleeps: { delay: Milliseconds; signal: AbortSignal | undefined; isEnded: boolean }[] =
    [];

  get sleeps(): readonly RecordedSleep[] {
    return this.#sleeps.map((sleep) => ({ ...sleep }));
  }

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    const sleep = { delay, signal, isEnded: false };
    this.#sleeps.push(sleep);
    return super.sleep(delay, signal).finally(() => {
      sleep.isEnded = true;
    });
  }

  /** The waits still running: neither run out nor ended by their signal. */
  pending(): readonly RecordedSleep[] {
    return this.sleeps.filter((sleep) => !sleep.isEnded && sleep.signal?.aborted !== true);
  }
}
