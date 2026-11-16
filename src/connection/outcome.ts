import { StoreOutcomeSource, StoreOutcomeUnknownError } from "@agboss/core/stores";
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  ErrorReply,
  MaxCommandRedirectionsError,
  ReconnectStrategyError,
  RootNodesUnavailableError,
} from "@redis/client";

/**
 * Which errors of a write leave its outcome unknown (agbossjs/agboss#1017, #928). A command whose
 * answer was lost may have taken effect: the framework never takes it as done and never as not
 * done — under a lease the holder hands the tree over and the next holder reconciles.
 *
 * The rule is a WHITELIST (the spec review of #1017): an error is "known", rethrown as it is, only
 * when it proves the command never ran; every other error after the send — and every error of a
 * shape this module does not recognise — is `StoreOutcomeUnknownError` (`source: Transport`, the
 * driver's error as `cause`). Redis never rolls a script back, so the server's own error in the
 * middle of a script (`OOM`, a `WRONGTYPE` on a later key) may follow a write: only a reply that is
 * the server's refusal BEFORE the script ran is known. A read is never classified: it has no effect.
 * An error that already is a `StoreOutcomeUnknownError` (a command timeout) passes through.
 *
 * Checked against `@redis/client` 6.3.0 (`node_modules/@redis/client/dist/lib/`).
 */

/** What the errors are attributed to: the one connection every store shares. */
const STORE = "RedisConnection";

/**
 * Classes that never saw a wire:
 * - `ClientOfflineError`, `ClientClosedError`: `client/index.js` `isPreEnqueueError` (line 88), thrown
 *   by `sendCommand` before the command is queued (lines 1129–1133);
 * - `ConnectionTimeoutError`: `client/socket.js:292`, the CONNECT timeout only — the socket was not
 *   yet open, so the commands waiting for it were never written (post-connect silence is
 *   `SocketTimeoutError`, line 307, unknown);
 * - `ReconnectStrategyError`: `socket.js:153`, the reconnect strategy gave up: no connection;
 * - `RootNodesUnavailableError`, `MaxCommandRedirectionsError`: cluster routing errors, thrown before
 *   a command is sent (this package refuses a cluster at start; kept for a hand-built client).
 */
const NEVER_SENT_CLASSES: readonly (abstract new (...args: never[]) => Error)[] = [
  ClientOfflineError,
  ClientClosedError,
  ConnectionTimeoutError,
  ReconnectStrategyError,
  RootNodesUnavailableError,
  MaxCommandRedirectionsError,
];

/** `commands-queue.js:197`: a full offline queue refuses the command before it is queued. */
const QUEUE_FULL = "The queue is full";

/**
 * Replies the server gives BEFORE it runs the script (the first word of the reply, exactly): the
 * script is not found, or the server refuses to start it. `NOSCRIPT` (`runScript` then retries
 * with `EVAL`), `BUSY` (another script holds the server), `LOADING`, `READONLY`, `MASTERDOWN`,
 * `NOAUTH`, `NOPERM`, `CLUSTERDOWN`, `NOREPLICAS`. The same word from INSIDE the script (a
 * `redis.call` refused) ends in ` script: <sha>, on @user_script:<line>.` and may follow a write:
 * that reply is unknown (`SCRIPT_MARKER`). Not listed on purpose: `OOM` (checked per command of the
 * script, after an earlier one wrote), `WRONGTYPE` and `ERR` (raised by a command mid-script).
 */
const REFUSED_BEFORE_RUN: ReadonlySet<string | undefined> = new Set([
  "NOSCRIPT",
  "BUSY",
  "LOADING",
  "READONLY",
  "MASTERDOWN",
  "NOAUTH",
  "NOPERM",
  "CLUSTERDOWN",
  "NOREPLICAS",
]);

/** The server appends the script's source name to every error a script's own command raised. */
const SCRIPT_MARKER = "@user_script";

/**
 * Node's connect errors (`syscall` `connect` / `getaddrinfo`, `net`/`dns`): the connection was
 * never made, so nothing was sent on it. A command written on an earlier connection was already
 * rejected with that connection's own error (`client/index.js:645`, `flushWaitingForReply`), so a
 * later connect error reaches only commands that were never written.
 */
const CONNECT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const CONNECT_SYSCALLS: ReadonlySet<string> = new Set(["connect", "getaddrinfo"]);

/** The refusal words, and `undefined` for a reply with no first word (never one of them). */
const isRefusalWord = (word: string | undefined): boolean => REFUSED_BEFORE_RUN.has(word);

const isRefusedBeforeRun = (error: unknown): boolean =>
  error instanceof ErrorReply &&
  !error.message.includes(SCRIPT_MARKER) &&
  isRefusalWord(error.message.split(" ", 1)[0]);

/** A property of a driver error as text (`"undefined"` when it has none: in no set below). */
const textOf = (error: Error, property: string): string => String(Reflect.get(error, property));

const isConnectError = (error: Error): boolean =>
  CONNECT_CODES.has(textOf(error, "code")) && CONNECT_SYSCALLS.has(textOf(error, "syscall"));

/** Whether `error` proves the command was never sent or never ran (the whitelist). */
export function isKnown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    NEVER_SENT_CLASSES.some((type) => error instanceof type) ||
    error.message === QUEUE_FULL ||
    isRefusedBeforeRun(error) ||
    isConnectError(error)
  );
}

/** `error` as it is, or as the error of unknown outcome a write's failure is read as. */
export function outcomeOf(error: unknown, operation: string): unknown {
  if (error instanceof StoreOutcomeUnknownError || isKnown(error)) return error;
  return new StoreOutcomeUnknownError({
    store: STORE,
    operation,
    source: StoreOutcomeSource.Transport,
    cause: error,
  });
}

/** Runs a write command (`operation` names it in the error): a failure is classified by `outcomeOf`. */
export async function writing<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw outcomeOf(error, operation);
  }
}
