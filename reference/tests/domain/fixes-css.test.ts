import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// D-78: the production CSS minifier treats a later -webkit-backdrop-filter as overriding an earlier backdrop-filter
// and drops the standard property, which Chrome needs. Prefixed first, standard last keeps both.
describe('D-78 backdrop-filter survives minification', () => {
  const dir = join(process.cwd(), 'src/app');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.css'))) {
    it(`D-78 ${file}: -webkit-backdrop-filter is never written after backdrop-filter in the same rule`, () => {
      const css = readFileSync(join(dir, file), 'utf8');
      for (const block of css.match(/\{[^{}]*\}/g) ?? []) {
        const standard = block.search(/(?<!-webkit-)backdrop-filter\s*:/);
        const prefixed = block.indexOf('-webkit-backdrop-filter');
        if (standard >= 0 && prefixed >= 0) expect(prefixed, block.slice(0, 160)).toBeLessThan(standard);
      }
    });
  }
});
