/**
 * agbossjs/agboss#989: the tests' server URLs name the address the server answers on, never
 * `localhost` — a connection to `localhost:<port>` whose IPv6 attempt found nothing listening could
 * be given that port as its own source and connect to itself.
 */
import { createServer, isIP, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedUrl } from "../support/pinned-url.js";
import { DURABLE_URL } from "../support/server.js";

let ipv4Only: Server;
let port = 0;

beforeAll(async () => {
  // as Docker publishes a port: on 127.0.0.1, nothing on ::1
  ipv4Only = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => ipv4Only.listen(0, "127.0.0.1", resolve));
  const address = ipv4Only.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterAll(async () => {
  await new Promise((resolve) => ipv4Only.close(resolve));
});

describe("#989: a test server's host is pinned to the address that answers", () => {
  it("localhost on a server listening on 127.0.0.1 only → 127.0.0.1; the rest of the URL kept", async () => {
    const url = `redis://user:se%40cret@localhost:${String(port)}/2`;

    expect(await pinnedUrl(url, 6379)).toBe(`redis://user:se%40cret@127.0.0.1:${String(port)}/2`);
  });

  it("an address already pinned is left as it is", async () => {
    const url = `redis://127.0.0.1:${String(port)}`;

    expect(await pinnedUrl(url, 6379)).toBe(url);
    expect(await pinnedUrl("redis://[::1]:6379", 6379)).toBe("redis://[::1]:6379");
  });

  it.skipIf(DURABLE_URL === "")(
    "the global setup pinned this run's URL: its host is an address",
    () => {
      expect(isIP(new URL(DURABLE_URL).hostname.replace(/^\[|\]$/gu, ""))).not.toBe(0);
    },
  );
});
