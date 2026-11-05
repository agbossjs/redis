#!/usr/bin/env node
/**
 * The `check:types` step (as agbossjs/postgres's): `agboss check` (the pinned `@agboss/cli`, `npm
 * run install:packed`) on the tests' layout application, which writes `.agboss/types.d.ts` — the
 * flow types its workflow compiles against. Never committed; run before lint and typecheck. The
 * check assembles the application only: the addresses its environment names are placeholders,
 * nothing connects.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = createRequire(join(ROOT, "package.json")).resolve("@agboss/cli/bin/agboss.js");
execFileSync(
  process.execPath,
  [cli, "check", "--application", "tests/fixtures/layout.application.ts", "--env", "layout"],
  {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      AGBOSS_LAYOUT_REDIS_URL: "redis://placeholder:6379",
      AGBOSS_LAYOUT_REDIS_PREFIX: "placeholder:",
      AGBOSS_LAYOUT_SQLITE_PATH: ":memory:",
      AGBOSS_LAYOUT_OPENROUTER_KEY: "placeholder",
    },
  },
);
console.log("check:types: wrote .agboss/types.d.ts");
