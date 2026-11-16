/**
 * agbossjs/agboss#777, #1213 — `openQueueWatch` on a subscriber the test drives: each message
 * wakes, a reconnect's `ready` wakes once (not the first connect's), nothing wakes once closed or
 * once the subscribe failed, and a failed subscribe leaves no socket.
 */
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it, vi } from "vitest";
import { openQueueWatch } from "../../src/stores/queue/queue-watch.js";
import { FakeSubscriber } from "../support/fake-subscriber.js";

describe("openQueueWatch (agbossjs/agboss#777)", () => {
  it("connects, subscribes on the channel, and each message wakes", async () => {
    const subscriber = new FakeSubscriber();
    const onQueued = vi.fn();

    await openQueueWatch(subscriber, "p:child-queued", onQueued, new VirtualClock());
    subscriber.publish();
    subscriber.publish();

    expect(subscriber.calls.connect).toBe(1);
    expect(subscriber.channel).toBe("p:child-queued");
    expect(onQueued).toHaveBeenCalledTimes(2);
  });

  it("the first connect's ready wakes nothing; every later ready (a reconnect) wakes once", async () => {
    const subscriber = new FakeSubscriber();
    const onQueued = vi.fn();

    await openQueueWatch(subscriber, "c", onQueued, new VirtualClock());
    expect(onQueued).not.toHaveBeenCalled();
    subscriber.ready();
    subscriber.ready();

    expect(onQueued).toHaveBeenCalledTimes(2);
  });

  it("a subscriber already connected is used as it is: its next ready wakes", async () => {
    const subscriber = new FakeSubscriber();
    subscriber.isOpen = true;
    subscriber.isReady = true;
    const onQueued = vi.fn();

    await openQueueWatch(subscriber, "c", onQueued, new VirtualClock());
    subscriber.ready();

    expect(subscriber.calls.connect).toBe(0);
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it("closed, it wakes nothing — no message, no ready — and closes its client once", async () => {
    const subscriber = new FakeSubscriber();
    const onQueued = vi.fn();
    const watch = await openQueueWatch(subscriber, "c", onQueued, new VirtualClock());

    await watch.close();
    await watch.close();
    subscriber.publish();
    subscriber.ready();

    expect(onQueued).not.toHaveBeenCalled();
    expect(subscriber.calls.close).toBe(1);
  });

  it("a subscribe that fails rejects, destroys the client, and its listener wakes nothing after", async () => {
    const subscriber = new FakeSubscriber();
    subscriber.answers.subscribe = () => Promise.reject(new Error("NOPERM"));
    const onQueued = vi.fn();

    await expect(openQueueWatch(subscriber, "c", onQueued, new VirtualClock())).rejects.toThrow(
      "NOPERM",
    );
    subscriber.publish();
    subscriber.ready();

    expect(subscriber.calls.destroy).toBe(1);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("a connect that fails rejects and destroys the client", async () => {
    const subscriber = new FakeSubscriber();
    subscriber.answers.connect = () => Promise.reject(new Error("ECONNREFUSED"));

    await expect(openQueueWatch(subscriber, "c", vi.fn(), new VirtualClock())).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(subscriber.calls.destroy).toBe(1);
    expect(subscriber.calls.subscribe).toBe(0);
  });
});
