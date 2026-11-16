import net from "node:net";

/** Where the proxy forwards to. */
export interface LinkTarget {
  readonly host: string;
  readonly port: number;
}

/** One client connection and its upstream. */
interface Link {
  readonly client: net.Socket;
  readonly upstream: net.Socket;
  /** Client bytes held while the proxy is frozen. */
  readonly held: Buffer[];
}

/**
 * A TCP proxy between a client and Redis that loses what a test tells it to (agbossjs/agboss#1017;
 * the shape of the core's `DatabaseProxy`, which is not a public entry): `freeze()` holds the
 * client's bytes back so the server never sees them, `drop()` cuts every link and refuses new
 * ones, `reconnect()` lets traffic through again, and `dropAfter(pattern)` forwards the next
 * client chunk that matches and then cuts that link — the server applies the command, the client
 * never hears the answer.
 */
export class LinkProxy {
  readonly #links = new Set<Link>();
  readonly #armed: RegExp[] = [];
  #state: "open" | "frozen" | "dropped" = "open";

  private constructor(
    private readonly server: net.Server,
    private readonly target: LinkTarget,
  ) {}

  /** Listens on a free port of 127.0.0.1, forwarding to `target`. */
  static async start(target: LinkTarget): Promise<LinkProxy> {
    const server = net.createServer();
    const proxy = new LinkProxy(server, target);
    server.on("connection", (client) => {
      proxy.#accept(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return proxy;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    return address.port;
  }

  freeze(): void {
    this.#state = "frozen";
  }

  drop(): void {
    this.#state = "dropped";
    for (const link of this.#links) this.#cut(link);
  }

  reconnect(): void {
    this.#state = "open";
  }

  /** The next client chunk matching `pattern` (as latin1 text) is forwarded, then its link cut. */
  dropAfter(pattern: RegExp): void {
    this.#armed.push(pattern);
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  #accept(client: net.Socket): void {
    if (this.#state === "dropped") {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    const link: Link = { client, upstream, held: [] };
    this.#links.add(link);
    const gone = (): void => {
      this.#cut(link);
    };
    client.on("error", gone).on("close", gone);
    upstream.on("error", gone).on("close", gone);
    upstream.on("data", (chunk) => {
      if (this.#links.has(link) && this.#state === "open") client.write(chunk);
    });
    client.on("data", (chunk: Buffer) => {
      this.#fromClient(link, chunk);
    });
  }

  #fromClient(link: Link, chunk: Buffer): void {
    if (this.#state === "frozen") {
      link.held.push(chunk);
      return;
    }
    const text = chunk.toString("latin1");
    const at = this.#armed.findIndex((pattern) => pattern.test(text));
    if (at < 0) {
      link.upstream.write(chunk);
      return;
    }
    this.#armed.splice(at, 1);
    // the server gets the bytes; the client is cut at once and hears nothing of the answer
    link.upstream.write(chunk, () => {
      this.#links.delete(link);
      link.client.destroy();
      link.upstream.end();
    });
  }

  #cut(link: Link): void {
    this.#links.delete(link);
    link.client.destroy();
    link.upstream.destroy();
  }
}
