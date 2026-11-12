/**
 * agbossjs/agboss#923 — the close at an instance's stop: in order when the server answers, the
 * socket destroyed past the grace when it does not. On the test clock, no real waiting.
 */
import { VirtualClock } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_GRACE, closeBounded } from "../../src/connection/close-bounded.js";

const never = (): Promise<void> => new Promise(() => undefined);

describe("closeBounded", () => {
  it("a close that ends in order destroys nothing", async () => {
    const destroy = vi.fn();

    await closeBounded({ close: () => Promise.resolve(), destroy }, new VirtualClock());

    expect(destroy).not.toHaveBeenCalled();
  });

  it("a close that never ends: the socket is destroyed once the grace passed on the clock", async () => {
    const clock = new VirtualClock();
    const destroy = vi.fn();
    let isDone = false;
    const closing = closeBounded({ close: never, destroy }, clock).then(() => {
      isDone = true;
    });

    await clock.advance(seconds(0.5));
    expect(isDone).toBe(false);
    await clock.advance(CLOSE_GRACE);
    await closing;

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("a close that fails is not a failure of the stop; a client already closed is not destroyed twice", async () => {
    const clock = new VirtualClock();
    const destroy = vi.fn(() => {
      throw new Error("the client is closed");
    });
    const closing = closeBounded(
      { close: () => Promise.reject(new Error("socket closed")), destroy },
      clock,
    );

    await expect(closing).resolves.toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    const stuck = closeBounded({ close: never, destroy }, clock);
    await clock.advance(CLOSE_GRACE);
    await expect(stuck).resolves.toBeUndefined();
  });

  it("without a clock the close is the orderly one only", async () => {
    const destroy = vi.fn();

    await closeBounded({ close: () => Promise.resolve(), destroy }, undefined);

    expect(destroy).not.toHaveBeenCalled();
  });
});
