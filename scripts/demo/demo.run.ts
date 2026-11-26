import { expect, it } from "vitest";
import { resetDemo, seedDemo } from "./seed";

// Not a test: the runner for `npm run demo:seed` and `npm run demo:reset` (vitest.demo.config.ts).
// DEMO_ACTION says which. What it did is printed; no password ever is.

const action = process.env.DEMO_ACTION;

it(`demo company: ${action ?? "nothing asked"}`, async () => {
  expect(["seed", "reset"]).toContain(action);
  const said = action === "seed" ? await seedDemo() : await resetDemo();
  // Written straight to the terminal: the test runner keeps what a passing run logs to itself.
  process.stdout.write(`\n${said.map((line) => `  ${line}`).join("\n")}\n\n`);
});
