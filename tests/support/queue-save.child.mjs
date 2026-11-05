// agbossjs/agboss#777 — another process queues one child: `node queue-save.child.mjs <url> <prefix>
// <executionId>`, on the built package (`npm test` builds first), its own connection. Prints the
// save's answer.
import process from "node:process";
import { RedisChildExecutionQueueRepository, RedisConnection } from "../../dist/index.js";

const [url, keyPrefix, executionId] = process.argv.slice(2);
const connection = new RedisConnection({ url, keyPrefix });
await connection.onInit();
try {
  // a save reads neither the clock nor the instance: the row brings its own times
  const queue = new RedisChildExecutionQueueRepository(connection, undefined, undefined);
  const saved = await queue.saveIfAbsent({
    tenantId: "default",
    executionId,
    rootExecutionId: "root-1",
    parentExecutionId: "root-1",
    rootWorkflow: "root-workflow",
    workflow: "child-workflow",
    depth: 2,
    run: "{}",
    status: "queued",
    queuedAt: new Date(0),
  });
  process.stdout.write(`saved ${String(saved)}\n`);
} finally {
  await connection.onDestroy();
}
