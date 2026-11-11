// npm run worker            keeps running, taking jobs as they become due
// npm run worker -- --once  runs what is due now, then stops
//
// The background worker. It is a separate process from the web app and holds the credentials the
// web app never does. Stop it with Ctrl+C: it finishes the job in hand first.
import { hostname } from "node:os";
import { adminSql } from "./lib/admin.mjs";
import { handlers } from "./lib/job-handlers.mjs";
import { runWorker } from "./lib/worker.mjs";

const once = process.argv.includes("--once");
const workerId = `${hostname()}:${process.pid}`;
const sql = adminSql();
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());

console.log(`Worker ${workerId} started${once ? " (one pass)" : ""}.`);
try {
  await runWorker(sql, handlers, {
    workerId,
    once,
    signal: stop.signal,
    // Ids and kinds only: a job's payload and error can hold customer data.
    log: (job) => console.log(`${new Date().toISOString()} ${job.kind} ${job.id} ${job.status}`),
    // The error's code only: its message can quote a query and the data in it.
    onError: (error) => console.error(`${new Date().toISOString()} database error (${error?.code ?? error?.name ?? "unknown"}); trying again`),
  });
} finally {
  await sql.end();
  console.log("Worker stopped.");
}
