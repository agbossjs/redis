import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUSED_BEFORE_RUN } from "../../src/connection/outcome.js";

/**
 * The invariant `outcome.ts` rests on (`RedisScript`, `scripts.ts`; agbossjs/agboss#1017): the
 * error of a script's own `redis.call` carries the server's ` script: <sha>, on @user_script:<n>.`
 * suffix, so a reply that starts with a refusal word and lacks it is read as "refused before the
 * script ran" (known). A script that returned such a reply of its own after a write
 * (`redis.error_reply("BUSY ...")`, `return { err = "BUSY ..." }`) would be read as known although
 * its write was applied. This scans the sources of `src/stores` and fails on any own error reply
 * that starts with one of the words, or whose text is not a plain literal (it cannot be checked).
 */
const STORES = fileURLToPath(new URL("../../src/stores", import.meta.url));

/** Every file under `directory`. */
const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );

/** The own error replies of `source`: `redis.error_reply(<text>)` and `{ err = <text> }`. */
const OWN_REPLY = /(?:error_reply\s*\(|\{\s*err\s*=)\s*(?:(['"])(.*?)\1)?/gu;

/** What is wrong with the own error replies of `source` (empty: nothing). */
export function replyProblemsOf(source: string): string[] {
  return [...source.matchAll(OWN_REPLY)].flatMap(([match, , text]) => {
    if (text === undefined) return [`${match.trim()}: the text is not a literal`];
    const word = text.trim().split(" ", 1)[0];
    return REFUSED_BEFORE_RUN.has(word) ? [`${match.trim()}: starts with ${String(word)}`] : [];
  });
}

describe("replyProblemsOf", () => {
  it.each([...REFUSED_BEFORE_RUN].filter((word) => word !== undefined))(
    "an own reply starting with %s is a problem, in either form and either quote",
    (word) => {
      expect(replyProblemsOf(`redis.error_reply('${word} x')`)).toHaveLength(1);
      expect(replyProblemsOf(`return redis.error_reply("${word} x")`)).toHaveLength(1);
      expect(replyProblemsOf(`return { err = "${word} x" }`)).toHaveLength(1);
      expect(replyProblemsOf(`return {err='  ${word}'}`)).toHaveLength(1);
    },
  );

  it("a reply of another word, a word that only begins like one, and no reply are no problem", () => {
    expect(replyProblemsOf("redis.error_reply('ERR no such tree')")).toEqual([]);
    expect(replyProblemsOf("redis.error_reply('BUSYGROUP x')")).toEqual([]);
    expect(replyProblemsOf("return redis.call('SET', KEYS[1], 1)")).toEqual([]);
  });

  it("a reply whose text is not a literal cannot be checked: a problem", () => {
    expect(replyProblemsOf("redis.error_reply(ARGV[1])")).toHaveLength(1);
    expect(replyProblemsOf("return { err = word }")).toHaveLength(1);
  });
});

describe("the scripts of the stores", () => {
  const files = filesUnder(STORES).filter((file) => file.endsWith(".ts"));

  it("the scan reaches the three script files", () => {
    for (const name of ["lease-scripts.ts", "queue-scripts.ts", "rate-limit-scripts.ts"])
      expect(files.some((file) => file.endsWith(name))).toBe(true);
  });

  it("none returns an own error reply that starts with a refusal word", () => {
    const problems = files.flatMap((file) =>
      replyProblemsOf(readFileSync(file, "utf8")).map((problem) => `${file}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });
});
