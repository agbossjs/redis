import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";

/**
 * The test server's URL with its host pinned to the address that answers (agbossjs/agboss#989):
 * `localhost` resolves to `::1` and `127.0.0.1`, and Docker publishes a port on `127.0.0.1` only.
 * A client tries `::1` first; when nothing listens there and the port is in the ephemeral range,
 * the kernel can give that attempt the same port as its own source — the socket connects to
 * itself, and the client reads its own commands back as replies (on PostgreSQL that hung a gate for 17
 * minutes). An address something listens on is
 * never handed out as a source port, so a pinned host cannot connect to itself.
 */
export async function pinnedUrl(url: string, defaultPort: number): Promise<string> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) return url;
  const port = parsed.port === "" ? defaultPort : Number(parsed.port);
  for (const { address, family } of await lookup(host, { all: true }))
    if (await isListening(address, port)) {
      parsed.hostname = family === 6 ? `[${address}]` : address;
      return parsed.toString();
    }
  return url;
}

/** Whether a server listens on `address`:`port` — a socket connected to itself is not one. */
const isListening = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: address, port, autoSelectFamily: false });
    socket.once("connect", () => {
      const isSelf = socket.localPort === port && socket.localAddress === socket.remoteAddress;
      socket.destroy();
      resolve(!isSelf);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
