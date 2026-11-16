/**
 * agbossjs/agboss#789, #1213 — the child queue's watch that notices a silently dead connection, on
 * subscribers the test drives and the test clock: a ping every half of the bound; one not answered
 * is a warning, its socket destroyed and a new subscription after a pause that doubles from 1 s to
 * 30 s, then one wake-up; a stopped connection ends the retries; a close ends everything at once,
 * a subscription in progress included, and leaves no wait behind.
 */
import { LogLevel } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { describe, expect, it, vi } from "vitest";
import { RedisConnectionClosedError } from "../../src/errors.js";
import { LivenessWatch } from "../../src/stores/queue/queue-watch-liveness.js";
import { FakeSubscriber, unanswered } from "../support/fake-subscriber.js";
import { RecordingClock } from "../support/recording-clock.js";
import { RecordingLogger } from "../support/recording-logger.js";

const LIVENESS = 10;
const HALF = seconds(LIVENESS / 2);

/** A watch whose subscribers come from `next` (one per subscription), on a recording clock. */
function setUp(next: () => FakeSubscriber = () => new FakeSubscriber()) {
  const clock = new RecordingClock();
  const logger = new RecordingLogger();
  const onQueued = vi.fn();
  const made: FakeSubscriber[] = [];
  const subscriber = vi.fn(() => {
    const client = next();
    made.push(client);
    return client;
  });
  const open = () =>
    LivenessWatch.open({
      subscriber,
      channel: "p:child-queued",
      onQueued,
      clock,
      livenessSeconds: LIVENESS,
      logger,
    });
  return { clock, logger, onQueued, made, subscriber, open };
}

/** A ping at half the bound, its answer due at the other half: a silent connection is lost then. */
async function lose(clock: RecordingClock): Promise<void> {
  await clock.advance(HALF);
  await clock.advance(HALF);
}

/** A subscriber whose pings are never answered: a connection that died silently. */
const silent = (): FakeSubscriber => {
  const client = new FakeSubscriber();
  client.answers.ping = unanswered;
  return client;
};

describe("LivenessWatch (agbossjs/agboss#789)", () => {
  it("subscribes on the channel; a message wakes; the ping's waits end with each answer", async () => {
    const { clock, onQueued, made, open } = setUp();

    const watch = await open();
    made[0]?.publish();
    await clock.advance(seconds(LIVENESS / 2));

    expect(made[0]?.channel).toBe("p:child-queued");
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(made[0]?.calls.ping).toBe(1);
    await watch.close();
    expect(clock.pending()).toEqual([]);
  });

  it("a silent connection: a warning, its socket destroyed (never closed), a new subscription after 1 s, one wake-up", async () => {
    let first = true;
    const { clock, logger, onQueued, made, subscriber, open } = setUp(() => {
      const client = first ? silent() : new FakeSubscriber();
      first = false;
      return client;
    });
    await open();

    await lose(clock);
    expect(logger.entries).toEqual([
      {
        level: LogLevel.Warn,
        code: "child-queue.watch-connection-lost",
        message:
          "The child queue's subscription is lost (no answer to a ping in 5 s); subscribing again",
        time: clock.now(),
      },
    ]);
    expect(made[0]?.calls).toMatchObject({ destroy: 1, close: 0 });
    expect(subscriber).toHaveBeenCalledTimes(1);
    await clock.advance(seconds(1));

    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(onQueued).toHaveBeenCalledTimes(1);
    made[1]?.publish();
    expect(onQueued).toHaveBeenCalledTimes(2);
  });

  it("the pauses before each new attempt: 1, 2, 4, 8, 16, then 30 s", async () => {
    let count = 0;
    const { clock, made, subscriber, open } = setUp(() => {
      count += 1;
      const client = count === 1 ? silent() : new FakeSubscriber();
      if (count > 1) client.answers.connect = () => Promise.reject(new Error("ECONNREFUSED"));
      return client;
    });
    await open();
    await lose(clock);
    const attempts: number[] = [];
    let elapsed = 0;
    while (attempts.length < 7) {
      await clock.advance(seconds(1));
      elapsed += 1;
      if (subscriber.mock.calls.length - 1 > attempts.length) attempts.push(elapsed);
    }

    expect(attempts).toEqual([1, 3, 7, 15, 31, 61, 91]);
    expect(made.slice(1).every((client) => client.calls.destroy > 0)).toBe(true);
  });

  it("a stopped connection ends the retries: no subscriber is asked for again", async () => {
    let count = 0;
    const { clock, subscriber, open } = setUp(() => {
      count += 1;
      if (count > 1) throw new RedisConnectionClosedError();
      return silent();
    });
    await open();

    await lose(clock);
    await clock.advance(seconds(1));
    expect(subscriber).toHaveBeenCalledTimes(2);
    for (let minute = 0; minute < 3; minute += 1) await clock.advance(seconds(60));

    expect(subscriber).toHaveBeenCalledTimes(2);
  });

  it("closed during a pause: no new subscription, ever, and no wake-up", async () => {
    const { clock, onQueued, subscriber, open } = setUp(silent);
    const watch = await open();
    await lose(clock);

    await watch.close();
    for (let minute = 0; minute < 3; minute += 1) await clock.advance(seconds(60));

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("closed during a subscription that hangs: the close ends at once, that client destroyed, no wake-up", async () => {
    let count = 0;
    const { clock, onQueued, made, open } = setUp(() => {
      count += 1;
      const client = count === 1 ? silent() : new FakeSubscriber();
      if (count > 1) client.answers.connect = unanswered;
      return client;
    });
    const watch = await open();
    await lose(clock);
    await clock.advance(seconds(1));
    expect(made).toHaveLength(2);

    await watch.close();

    expect(made[1]?.calls.destroy).toBe(1);
    expect(onQueued).not.toHaveBeenCalled();
    expect(clock.pending()).toEqual([]);
  });

  it("closed: its ping stops, its client closes once, nothing is warned or subscribed again", async () => {
    const { clock, logger, made, subscriber, open } = setUp();
    const watch = await open();
    await clock.advance(seconds(LIVENESS / 2));
    expect(made[0]?.calls.ping).toBe(1);

    await watch.close();
    for (let minute = 0; minute < 3; minute += 1) await clock.advance(seconds(60));

    expect(made[0]?.calls).toMatchObject({ ping: 1, close: 1 });
    expect(logger.entries).toEqual([]);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it("closed after a lost connection was replaced: the lost client is not closed, the new one is", async () => {
    let first = true;
    const { clock, made, open } = setUp(() => {
      const client = first ? silent() : new FakeSubscriber();
      first = false;
      return client;
    });
    const watch = await open();
    await lose(clock);
    await clock.advance(seconds(1));

    await watch.close();

    expect(made[0]?.calls.close).toBe(0);
    expect(made[1]?.calls.close).toBe(1);
  });

  it("a server that never answers the subscription: it rejects once the bound passed — not before — and destroys the client", async () => {
    const hung = new FakeSubscriber();
    hung.answers.connect = unanswered;
    const { clock, open } = setUp(() => hung);
    let settled = false;
    const opening = open().finally(() => {
      settled = true;
    });
    const failed = expect(opening).rejects.toThrow("the server did not answer in time");

    await clock.advance(seconds(LIVENESS - 0.1));
    expect(settled).toBe(false);
    await clock.advance(seconds(0.1));

    await failed;
    expect(hung.calls.destroy).toBe(1);
  });

  it("a subscription that answers ends its wait for the bound: no timer is left behind", async () => {
    const { clock, open } = setUp();

    const watch = await open();

    const [bound] = clock.sleeps;
    expect(bound?.delay).toBe(seconds(LIVENESS));
    expect(bound?.signal?.aborted).toBe(true);
    await watch.close();
  });
});
