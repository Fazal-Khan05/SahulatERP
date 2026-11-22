import { it } from "vitest";
import { measurePerf } from "./measure";
import { resetPerf, seedPerf } from "./seed";

// Run by `npm run perf:seed`, `npm run perf:measure` and `npm run perf:reset` (vitest.perf.config.ts),
// against a local database. Not a test: nothing here is collected by `npm test`.
const action = process.env.PERF_ACTION;

it(`performance company: ${action}`, async () => {
  const said = action === "seed" ? await seedPerf() : action === "reset" ? await resetPerf() : action === "measure" ? await measurePerf() : [`Unknown PERF_ACTION: ${action}`];
  console.log(said.join("\n"));
});
