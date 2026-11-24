import type { createClient } from "@redis/client";

/** The full node-redis client of an instance (RESP2 replies): the package's own use and its tests', never its API. */
export type NodeRedisClient = ReturnType<typeof createClient>;

/**
 * What the package's stores, and an application that asks `RedisConnection.client` for a command
 * of its own, need of the instance's Redis client (agbossjs/agboss#1321f): an interface of the
 * package, not node-redis's own type — the driver library is no part of the public surface, and a
 * new major of it changes none of this. Every command runs on the one durable primary the
 * connection checked at start.
 */
export interface RedisClient {
  /** `EVALSHA`: a script the server has loaded, by its SHA-1, with its keys and arguments. */
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  /** `EVAL`: a script by its source, with its keys and arguments. */
  eval(source: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  /** `PING`: the server's answer, `PONG`. */
  ping(): Promise<string>;
  /** `EXISTS` of one key: 1 when it exists, else 0. */
  exists(key: string): Promise<number>;
  /** `GET`: the string at `key`, `null` when there is none. */
  get(key: string): Promise<string | null>;
  /** `HGETALL`: every field of the hash at `key`, empty when there is none. */
  hGetAll(key: string): Promise<Record<string, string>>;
  /** `ZREM` of one member: how many were removed. */
  zRem(key: string, member: string): Promise<number>;
  /** `DEL`: how many keys were removed. */
  del(keys: string[]): Promise<number>;
}
