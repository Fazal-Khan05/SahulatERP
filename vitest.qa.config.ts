import { defineConfig } from 'vitest/config';

// The SQA pack (docs/qa/cases). Kept out of `npm test` so open defects don't block CI.
export default defineConfig({
  test: { include: ['tests/qa/**/*.test.ts'], reporters: ['default', 'json'], outputFile: { json: 'reports/qa-run/vitest.json' } },
});
