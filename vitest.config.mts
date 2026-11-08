import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Unit tests live beside the code; reference/ and e2e/ are never collected.
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
