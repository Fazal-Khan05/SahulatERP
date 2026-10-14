/**
 * Joins the SQA case files (docs/qa/cases/*.md) with test results and writes
 * reports/qa-run/RESULTS.md and reports/qa-run/results.json.
 *   Inputs: reports/qa-run/vitest.json (npm run test:qa), reports/qa-run/playwright.json (QA browser pass).
 * A case's status: pass | fail | browser-todo | manual | missing. A case run in both layers
 * takes the worse of the two (fail > pass), and a browser result replaces a browser todo.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Status = 'pass' | 'fail' | 'browser-todo' | 'manual' | 'missing';
type Case = { id: string; area: string; file: string; priority: string; type: string; text: string; expected: string };
type Result = { status: Status; title: string; layer: 'engine' | 'browser'; message?: string; tags: string[] };

const root = process.cwd();
const casesDir = join(root, 'docs/qa/cases');
const outDir = join(root, 'reports/qa-run');

const cases: Case[] = [];
for (const file of readdirSync(casesDir).filter(f => f.endsWith('.md')).sort()) {
  const area = readFileSync(join(casesDir, file), 'utf8').split('\n')[0].replace(/^#\s*\d+\s*—\s*/, '').trim();
  for (const line of readFileSync(join(casesDir, file), 'utf8').split('\n')) {
    const m = line.match(/^\| ([A-Z]{3,4}-\d{3}) \| (P\d) \| ([A-Z]) \| (.*) \| (.*) \|$/);
    if (m) cases.push({ id: m[1], priority: m[2], type: m[3], text: m[4], expected: m[5], area, file });
  }
}

const idOf = (title: string) => title.match(/^([A-Z]{3,4}-\d{3})\b/)?.[1];
const tagsOf = (title: string) => [...title.matchAll(/\[(defect|documented|case-corrected|browser|manual|db)[^\]]*\]/g)].map(m => m[0]);
const results = new Map<string, Result[]>();
const add = (id: string, r: Result) => results.set(id, [...(results.get(id) ?? []), r]);

const vitestPath = join(outDir, 'vitest.json');
if (existsSync(vitestPath)) {
  const v = JSON.parse(readFileSync(vitestPath, 'utf8')) as { testResults: { assertionResults: { title: string; status: string; failureMessages?: string[] }[] }[] };
  for (const file of v.testResults) for (const a of file.assertionResults) {
    const id = idOf(a.title); if (!id) continue;
    const tags = tagsOf(a.title);
    const status: Status = a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : /\[browser\]/.test(a.title) ? 'browser-todo' : 'manual';
    add(id, { status, title: a.title, layer: 'engine', message: a.failureMessages?.[0]?.split('\n')[0], tags });
  }
}

type PwSuite = { title: string; specs?: { title: string; tests: { results: { status: string; error?: { message?: string } }[]; annotations?: { type: string }[] }[] }[]; suites?: PwSuite[] };
const pwPath = join(outDir, 'playwright.json');
if (existsSync(pwPath)) {
  const p = JSON.parse(readFileSync(pwPath, 'utf8')) as { suites: PwSuite[] };
  const walk = (s: PwSuite) => {
    for (const spec of s.specs ?? []) {
      const id = idOf(spec.title); if (!id) continue;
      const last = spec.tests[0]?.results.at(-1);
      const skipped = !last || last.status === 'skipped';
      const status: Status = skipped ? (/\[manual\]/.test(spec.title) ? 'manual' : 'browser-todo') : last.status === 'passed' ? 'pass' : 'fail';
      add(id, { status, title: spec.title, layer: 'browser', message: last?.error?.message?.split('\n')[0], tags: tagsOf(spec.title) });
    }
    (s.suites ?? []).forEach(walk);
  };
  p.suites.forEach(walk);
}

const rank: Record<Status, number> = { fail: 5, pass: 4, 'browser-todo': 2, manual: 1, missing: 0 };
const final = cases.map(c => {
  const rs = results.get(c.id) ?? [];
  let status: Status = 'missing';
  const executed = rs.filter(r => r.status === 'pass' || r.status === 'fail');
  if (executed.some(r => r.status === 'fail')) status = 'fail';
  else if (executed.length) status = 'pass';
  else if (rs.some(r => r.status === 'browser-todo')) status = 'browser-todo';
  else if (rs.some(r => r.status === 'manual')) status = 'manual';
  const tags = [...new Set(rs.flatMap(r => r.tags))];
  return { ...c, status, layers: [...new Set(executed.map(r => r.layer))], tags, titles: rs.map(r => r.title), message: rs.find(r => r.status === 'fail')?.message };
});
void rank;

const areas = [...new Set(final.map(c => c.area))];
const count = (list: typeof final, s: Status) => list.filter(c => c.status === s).length;
const lines: string[] = [];
const total = final.length;
lines.push('# SahulatERP SQA run — results', '', `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from \`npm run test:qa\` and the QA browser pass.`, '');
lines.push('| Area | Cases | Pass | Fail | Browser not yet run | Manual only | Missing |', '|---|---|---|---|---|---|---|');
for (const a of areas) { const l = final.filter(c => c.area === a); lines.push(`| ${a} | ${l.length} | ${count(l, 'pass')} | ${count(l, 'fail')} | ${count(l, 'browser-todo')} | ${count(l, 'manual')} | ${count(l, 'missing')} |`); }
lines.push(`| **Total** | **${total}** | **${count(final, 'pass')}** | **${count(final, 'fail')}** | **${count(final, 'browser-todo')}** | **${count(final, 'manual')}** | **${count(final, 'missing')}** |`, '');
const failed = final.filter(c => c.status === 'fail');
lines.push(`## Failures (${failed.length})`, '');
if (failed.length) { lines.push('| ID | P | Case | Failing test | First error line |', '|---|---|---|---|---|'); for (const c of failed) lines.push(`| ${c.id} | ${c.priority} | ${c.text.replaceAll('|', '/')} | ${(c.titles.find(t => true) ?? '').replaceAll('|', '/')} | ${(c.message ?? '').replaceAll('|', '/').slice(0, 200)} |`); }
else lines.push('None.');
const corrected = final.filter(c => c.tags.some(t => t.startsWith('[case-corrected')));
lines.push('', `## Case corrections (${corrected.length})`, '', ...corrected.map(c => `- ${c.id}: ${c.tags.filter(t => t.startsWith('[case-corrected')).join(' ')}`));
const documented = final.filter(c => c.tags.some(t => t.startsWith('[documented')));
lines.push('', `## Behaviour recorded where the case asked "assert/verify" (${documented.length})`, '', ...documented.map(c => `- ${c.id}: ${c.tags.filter(t => t.startsWith('[documented')).join(' ')}`));
const manual = final.filter(c => c.status === 'manual');
lines.push('', `## Manual-only cases (${manual.length})`, '', ...manual.map(c => `- ${c.id} ${c.text.slice(0, 120)} — ${(c.titles[0] ?? '').replace(/^[A-Z]{3,4}-\d{3}\s*/, '')}`));
const todo = final.filter(c => c.status === 'browser-todo');
lines.push('', `## Browser cases not yet run (${todo.length})`, '', ...todo.map(c => `- ${c.id} ${c.text.slice(0, 140)}`));
const missing = final.filter(c => c.status === 'missing');
lines.push('', `## Missing (no test or todo) (${missing.length})`, '', ...missing.map(c => `- ${c.id}`));

writeFileSync(join(outDir, 'RESULTS.md'), lines.join('\n') + '\n');
writeFileSync(join(outDir, 'results.json'), JSON.stringify(final, null, 2));
console.log(JSON.stringify({ total, pass: count(final, 'pass'), fail: count(final, 'fail'), browserTodo: count(final, 'browser-todo'), manual: count(final, 'manual'), missing: count(final, 'missing') }));
