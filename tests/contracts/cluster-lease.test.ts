import {
  executionLeaseClusterContract,
  type ClusterLeaseSet,
} from "@agboss/core/testing/contracts";
import { afterAll, describe } from "vitest";
import type { RedisConnection } from "../../src/index.js";
import { RedisExecutionLeaseRepository } from "../../src/index.js";
import { redisStore, testKeySpace, type SharedKeptIds } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

/**
 * #1321e (D6) — the core's cluster lease contract on Redis, beside the database's lease store (the
 * core's SQLite one on a file of the test's own, standing for PostgreSQL's or MongoDB's): the take
 * mirrored into the row before it is handed out, a release written before the key changes, a Redis
 * behind the row raised past it, marks pushed after the row and read from the row only, and a
 * database or a Redis that is down failing every one of those closed.
 */
describe.skipIf(DURABLE_URL === "")("the cluster lease contract on Redis", () => {
  const space = testKeySpace("cluster-lease");

  afterAll(async () => {
    await space.close();
  });

  /** A connection whose commands reject while `isDown`: the instance's Redis cut off. */
  const cuttable = (connection: RedisConnection, isDown: () => boolean): RedisConnection =>
    Object.create(connection, {
      client: {
        value: new Proxy(connection.client, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) =>
              isDown()
                ? Promise.reject(new Error("Redis is down"))
                : (Reflect.apply(value, target, args) as unknown);
          },
        }),
      },
      ping: {
        value: () => (isDown() ? Promise.reject(new Error("Redis is down")) : connection.ping()),
      },
    }) as RedisConnection;

  /** The database's lease store, every call rejecting while `isDown`. */
  const cuttableDatabase = (database: SharedKeptIds, isDown: () => boolean): SharedKeptIds =>
    new Proxy(database, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          isDown()
            ? Promise.reject(new Error("the database is down"))
            : (Reflect.apply(value, target, args) as unknown);
      },
    });

  executionLeaseClusterContract({
    name: "Redis",
    reset: () => space.reset(),
    ...redisStore<ClusterLeaseSet>(space, (connection, seam) => {
      let isClusterDown = false;
      let isDatabaseDown = false;
      // the file's one durable lease store: the database every instance's row is in
      const database = space.keptIds;
      return {
        cluster: new RedisExecutionLeaseRepository(
          cuttable(connection, () => isClusterDown),
          seam.storeClock,
          seam.application,
          cuttableDatabase(database, () => isDatabaseDown),
        ),
        database,
        outage: {
          cluster: (isDown) => {
            isClusterDown = isDown;
          },
          database: (isDown) => {
            isDatabaseDown = isDown;
          },
        },
      };
    }),
  });
});
