/**
 * agbossjs/agboss#789, #1213 — `watchLiveness`: a ping every half of the liveness bound, its answer
 * due within the other half, all on the clock; it resolves with why the connection is dead, or
 * with `undefined` once its signal ends it, and leaves no wait behind.
 */
import { seconds } from "@agboss/core/units";
import { describe, expect, it, vi } from "vitest";
import { watchLiveness } from "../../src/connection/heartbeat.js";
import { RecordingClock } from "../support/recording-clock.js";

const LIVENESS = 10;
const HALF = seconds(LIVENESS / 2);
const never = (): Promise<unknown> => new Promise(() => undefined);

/** `watchLiveness` on a recording clock with `ping`; the watch, its stop and the clock. */
function watched(ping: () => Promise<unknown>) {
  const clock = new RecordingClock();
  const stop = new AbortController();
  /** What the watch resolved with; `pending` until it did. */
  let ended: { readonly outcome: string | undefined } | "pending" = "pending";
  const watch = watchLiveness({ clock, livenessSeconds: LIVENESS, ping, signal: stop.signal }).then(
    (outcome) => {
      ended = { outcome };
      return outcome;
    },
  );
  return { clock, stop, watch, ended: () => ended };
}

describe("watchLiveness (agbossjs/agboss#789)", () => {
  it("pings once every half of the bound while the pings are answered", async () => {
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const { clock, stop, watch, ended } = watched(ping);

    await clock.advance(seconds(LIVENESS / 2 - 0.1));
    expect(ping).not.toHaveBeenCalled();
    await clock.advance(seconds(0.1));
    expect(ping).toHaveBeenCalledTimes(1);
    await clock.advance(HALF);
    await clock.advance(HALF);
    expect(ping).toHaveBeenCalledTimes(3);
    expect(ended()).toBe("pending");
    stop.abort();
    await expect(watch).resolves.toBeUndefined();
  });

  it("an answered ping's wait for its answer ends with it: no timer is left behind", async () => {
    const { clock, stop, watch } = watched(() => Promise.resolve("PONG"));

    await clock.advance(HALF);
    await clock.advance(seconds(0.1));
    const answerWaits = clock.sleeps.slice(1, 2);
    expect(answerWaits.map((sleep) => sleep.signal?.aborted)).toEqual([true]);
    stop.abort();
    await watch;
    expect(clock.pending()).toEqual([]);
  });

  it("a ping that fails is the reason, with its error", async () => {
    const { clock, watch } = watched(() => Promise.reject(new Error("socket closed")));

    await clock.advance(HALF);

    await expect(watch).resolves.toBe("the ping failed: Error: socket closed");
  });

  it("a ping not answered within the other half is the reason — not before", async () => {
    const { clock, watch, ended } = watched(never);

    await clock.advance(HALF);
    await clock.advance(seconds(LIVENESS / 2 - 0.1));
    expect(ended()).toBe("pending");
    await clock.advance(seconds(0.1));

    await expect(watch).resolves.toBe("no answer to a ping in 5 s");
  });

  it("a signal that ends it before a ping: undefined, and nothing is pinged", async () => {
    const ping = vi.fn(never);
    const { clock, stop, watch } = watched(ping);

    stop.abort();
    await clock.advance(HALF);

    await expect(watch).resolves.toBeUndefined();
    expect(ping).not.toHaveBeenCalled();
  });

  it("a signal that ends it while a ping waits for its answer: undefined, not the silence", async () => {
    const { clock, stop, watch } = watched(never);

    await clock.advance(HALF);
    stop.abort();
    await clock.advance(HALF);

    await expect(watch).resolves.toBeUndefined();
  });

  it("a signal that ends it while a ping fails: undefined, not the failure", async () => {
    let fail: (error: Error) => void = () => undefined;
    const { clock, stop, watch } = watched(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );

    await clock.advance(HALF);
    stop.abort();
    fail(new Error("closed by the stop"));

    await expect(watch).resolves.toBeUndefined();
  });
});
