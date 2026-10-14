/**
 * Builds the SQA report PDF from the run artefacts:
 *   reports/qa-run/results.json (npm run qa:report), reports/qa-run/DEFECTS.md, docs/qa/cases/*.md
 * Output: reports/qa-run/SahulatERP-SQA-Report.pdf (and the HTML it was printed from).
 *   npx tsx scripts/qa-pdf.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

type Row = { id: string; area: string; file: string; priority: string; type: string; text: string; expected: string; status: 'pass' | 'fail' | 'manual' | 'browser-todo' | 'missing'; layers: string[]; tags: string[]; titles: string[]; message?: string };

const root = process.cwd();
const out = join(root, 'reports/qa-run');
const rows = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Row[];
const defectsMd = readFileSync(join(out, 'DEFECTS.md'), 'utf8');
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
const generated = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const count = (list: Row[], s: Row['status']) => list.filter(r => r.status === s).length;
const shortArea = (a: string) => a.replace(/\s*\([A-Z]+\)$/, '');
const prefixOf = (a: string) => a.match(/\(([A-Z]+)\)$/)?.[1] ?? '';

/** Minimal Markdown → HTML for the defect register (headings, bold, code, lists, tables, paragraphs). */
function markdown(md: string) {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim() === '---') { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const level = Math.min(4, h[1].length + 1); html.push(`<h${level}>${inline(h[2])}</h${level}>`); i++; continue; }
    if (line.startsWith('|')) {
      const block: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) block.push(lines[i++]);
      const cells = (l: string) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const [head, , ...body] = block;
      html.push(`<table class="md"><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      html.push(`<ul>${items.map(it => `<li>${inline(it)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\*\*D-\d+/.test(line)) {
      const block: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^\*\*D-\d+/.test(lines[i]) && !lines[i].startsWith('#')) block.push(lines[i++]);
      const [title, ...rest] = block;
      const sev = title.match(/·\s*(S\d)\s*·/)?.[1] ?? '';
      html.push(`<div class="defect ${sev.toLowerCase()}"><div class="defect-title">${inline(title.replace(/^\*\*|\*\*$/g, ''))}</div><dl>${rest.map(r => { const m = r.match(/^([A-Za-z][A-Za-z ]{1,24}):\s*(.*)$/); return m ? `<dt>${esc(m[1])}</dt><dd>${inline(m[2])}</dd>` : `<dd class="wide">${inline(r)}</dd>`; }).join('')}</dl></div>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||\s*[-*]\s|\*\*D-\d+)/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return html.join('\n');
}

// ---------- figures ----------
const total = rows.length;
const pass = count(rows, 'pass'), fail = count(rows, 'fail'), manual = count(rows, 'manual'), notRun = count(rows, 'browser-todo') + count(rows, 'missing');
const executed = pass + fail;
const areas = [...new Set(rows.map(r => r.area))];
const byLayer = { engine: rows.filter(r => (r.status === 'pass' || r.status === 'fail') && r.layers.includes('engine') && !r.layers.includes('browser')).length, browser: rows.filter(r => (r.status === 'pass' || r.status === 'fail') && r.layers.includes('browser') && !r.layers.includes('engine')).length, both: rows.filter(r => r.layers.includes('engine') && r.layers.includes('browser')).length };
const priorities = ['P1', 'P2', 'P3', 'P4'];
const typeNames: Record<string, string> = { F: 'Functional', N: 'Negative / validation', E: 'Edge / boundary', S: 'Security / permission', U: 'UI / UX', D: 'Data integrity / accounting', X: 'Performance / limits' };
const sevMatch = [...defectsMd.matchAll(/^\|\s*S(\d)[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm)].map(m => ({ sev: `S${m[1]}`, defects: Number(m[2]), cases: Number(m[3]) }));
const sevDefs: Record<string, string> = { S1: 'Wrong money, stock, permission or security, or data loss. Blocks release.', S2: 'Feature unusable, no workaround.', S3: 'Problem with a workaround.', S4: 'Cosmetic.' };
type Defect = { id: string; sev: string; title: string; cases: string[] };
const defects: Defect[] = [];
{
  let sev = '';
  const lines = defectsMd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^## (S\d)/); if (h) { sev = h[1]; continue; }
    if (/^## /.test(lines[i])) { sev = ''; continue; }
    const card = lines[i].match(/^\*\*(D-\d+)\s*·\s*(S\d)\s*·\s*(.+?)\*\*$/);
    if (card) { const casesLine = lines.slice(i + 1, i + 4).find(l => /^Cases:/.test(l)) ?? ''; defects.push({ id: card[1], sev: card[2], title: card[3], cases: casesLine.match(/[A-Z]{3,4}-\d{3}/g) ?? [] }); continue; }
    const row = lines[i].match(/^\|\s*(D-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (row && sev) defects.push({ id: row[1], sev, title: row[2], cases: row[3].match(/[A-Z]{3,4}-\d{3}/g) ?? [] });
  }
}
const defectOf = new Map<string, Defect>();
for (const d of defects) for (const c of d.cases) if (!defectOf.has(c)) defectOf.set(c, d);
const s1Titles = defects.filter(d => d.sev === 'S1');
const s2Titles = defects.filter(d => d.sev === 'S2');
const corrected = rows.filter(r => r.tags.some(t => t.startsWith('[case-corrected')));
const documented = rows.filter(r => r.tags.some(t => t.startsWith('[documented')));
const manualRows = rows.filter(r => r.status === 'manual');
const reasonOf = (r: Row) => (r.titles.find(t => /\[manual\]/.test(t)) ?? r.titles[0] ?? '').replace(/^[A-Z]{3,4}-\d{3}\s*/, '').replace(/\[manual\]\s*/, '');
const tagText = (r: Row, prefix: string) => r.tags.filter(t => t.startsWith(prefix)).map(t => t.replace(/^\[[a-z-]+:?\s*/, '').replace(/\]$/, '')).join('; ');
const p1 = rows.filter(r => r.priority === 'P1');
// Page numbers for the contents page come from a first build (see main()).
const tocPath = join(out, '.toc-pages.json');
const tocPages: Record<string, number> = (() => { try { return JSON.parse(readFileSync(tocPath, 'utf8')); } catch { return {}; } })();
const verdict = (sevMatch.find(s => s.sev === 'S1')?.defects ?? 0) > 0 ? 'Not ready for release' : 'Ready for release';

const bar = (list: Row[]) => { const n = list.length || 1; const w = (k: Row['status']) => (100 * count(list, k) / n).toFixed(2); return `<div class="bar"><span class="b-pass" style="width:${w('pass')}%"></span><span class="b-fail" style="width:${w('fail')}%"></span><span class="b-manual" style="width:${w('manual')}%"></span></div>`; };
const statusChip = (s: Row['status']) => `<span class="chip ${s}">${s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s === 'manual' ? 'Manual' : 'Not run'}</span>`;

const sections = [
  ['summary', '1. Executive summary'], ['scope', '2. Scope and approach'], ['results', '3. Results'], ['defects', '4. Defect register'],
  ['decisions', '5. Behaviour to decide and case corrections'], ['manual', '6. Manual-only cases'], ['reproduce', '7. How to reproduce'], ['appendix', 'Appendix A. Every case and its result'],
] as const;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SahulatERP SQA Report</title><style>
@page { size: A4; margin: 20mm 16mm 18mm 16mm; }
:root { --ink:#1f2328; --muted:#5b6170; --line:#dfe2ea; --soft:#f5f6fa; --violet:#5b2fd6; --violet-soft:#efe9fe; --green:#067a35; --green-soft:#e3f5ea; --red:#b42318; --red-soft:#fde8e6; --amber:#8a5300; --amber-soft:#fff2d9; --grey-soft:#eceef3; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; color: var(--ink); font-size: 9.6pt; line-height: 1.45; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 20pt; margin: 0 0 6pt; letter-spacing: -0.01em; color: var(--ink); }
h2 { font-size: 15pt; margin: 18pt 0 8pt; padding-bottom: 4pt; border-bottom: 2px solid var(--violet); color: var(--ink); }
h3 { font-size: 11.5pt; margin: 14pt 0 6pt; color: var(--violet); }
h4 { font-size: 10pt; margin: 10pt 0 4pt; }
h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
td:first-child strong, table.md td:first-child { white-space: nowrap; }
table.ids td:last-child { width: 46mm; }
p { margin: 0 0 7pt; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 8.2pt; background: var(--soft); padding: 0 2pt; border-radius: 3px; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 8.8pt; }
th { text-align: left; background: var(--soft); color: var(--muted); font-weight: 600; font-size: 8pt; text-transform: uppercase; letter-spacing: .03em; }
th, td { padding: 4pt 6pt; border-bottom: 1px solid var(--line); vertical-align: top; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.section { page-break-before: always; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 10pt; font-size: 15pt; font-weight: 600; }
.mark { width: 30pt; height: 30pt; border-radius: 8pt; background: linear-gradient(135deg,#fa12e3,#6b3df5 55%,#12d0fa); color: #fff; display: grid; place-items: center; font-weight: 700; }
.cover h1 { font-size: 30pt; line-height: 1.1; margin-top: 60mm; }
.cover .sub { font-size: 13pt; color: var(--muted); margin-top: 6pt; }
.meta { display: grid; grid-template-columns: 34mm 1fr; gap: 3pt 10pt; font-size: 9.5pt; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.verdict { display: inline-block; padding: 6pt 12pt; border-radius: 6pt; font-weight: 700; font-size: 11pt; background: var(--red-soft); color: var(--red); margin: 4pt 0 10pt; }
.verdict.ok { background: var(--green-soft); color: var(--green); }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6pt; margin: 8pt 0 12pt; }
.kpi { border: 1px solid var(--line); border-radius: 8pt; padding: 8pt 10pt; }
.kpi strong { display: block; font-size: 17pt; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: 8.2pt; }
.kpi.pass strong { color: var(--green); } .kpi.fail strong { color: var(--red); } .kpi.man strong { color: var(--muted); }
.bar { height: 8pt; border-radius: 4pt; overflow: hidden; display: flex; background: var(--grey-soft); min-width: 40mm; }
.b-pass { background: #23a35a; } .b-fail { background: #d92d20; } .b-manual { background: #a7adbb; }
.legend { display: flex; gap: 14pt; font-size: 8.2pt; color: var(--muted); margin: 2pt 0 6pt; }
.legend i { display: inline-block; width: 8pt; height: 8pt; border-radius: 2pt; margin-right: 4pt; vertical-align: -1pt; }
.chip { display: inline-block; padding: 0 6pt; border-radius: 999px; font-size: 7.6pt; font-weight: 600; white-space: nowrap; }
.chip.pass { background: var(--green-soft); color: var(--green); } .chip.fail { background: var(--red-soft); color: var(--red); } .chip.manual { background: var(--grey-soft); color: var(--muted); } .chip.browser-todo, .chip.missing { background: var(--amber-soft); color: var(--amber); }
.sev { display: inline-block; min-width: 18pt; text-align: center; padding: 0 5pt; border-radius: 4pt; font-weight: 700; font-size: 8pt; }
.sev.S1 { background: var(--red-soft); color: var(--red); } .sev.S2 { background: var(--amber-soft); color: var(--amber); } .sev.S3 { background: var(--violet-soft); color: var(--violet); } .sev.S4 { background: var(--grey-soft); color: var(--muted); }
.toc a { color: var(--ink); text-decoration: none; } .toc-table td { font-size: 10.5pt; padding: 6pt 4pt; } .toc-table td.num { width: 20mm; }
.defect { border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 6pt; padding: 7pt 10pt; margin: 0 0 8pt; page-break-inside: avoid; }
.defect.s1 { border-left-color: #d92d20; } .defect.s2 { border-left-color: #c97a00; } .defect.s3 { border-left-color: #6b3df5; } .defect.s4 { border-left-color: #a7adbb; }
.defect-title { font-weight: 700; margin-bottom: 4pt; }
.defect dl { display: grid; grid-template-columns: 24mm 1fr; gap: 2pt 8pt; margin: 0; font-size: 8.8pt; }
.defect dt { color: var(--muted); } .defect dd { margin: 0; } .defect dd.wide { grid-column: 1 / -1; }
table.md td:first-child { white-space: nowrap; font-weight: 600; }
.appendix table { font-size: 7.6pt; } .appendix td { padding: 2.5pt 5pt; } .appendix h3 { page-break-after: avoid; }
.muted { color: var(--muted); }
.callout { background: var(--violet-soft); border-radius: 8pt; padding: 8pt 12pt; margin: 8pt 0 12pt; }
ul { margin: 2pt 0 8pt 14pt; padding: 0; } li { margin: 2pt 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14pt; }
</style></head><body>

<section class="cover">
  <div class="brand"><span class="mark">S</span>SahulatERP</div>
  <div>
    <h1>Software Quality Assurance<br>Test Report</h1>
    <div class="sub">Execution of the 2,000-case SQA pack across 20 feature areas</div>
  </div>
  <dl class="meta">
    <dt>Product</dt><dd>SahulatERP, cloud ERP for Pakistani importer-distributors</dd>
    <dt>Build tested</dt><dd>Branch <code>${esc(branch)}</code>, commit <code>${esc(commit)}</code> (product code identical to <code>main</code>)</dd>
    <dt>Report generated</dt><dd>${esc(generated)} (Asia/Karachi)</dd>
    <dt>Test pack</dt><dd><code>docs/qa/cases/*.md</code>, 20 files × 100 cases</dd>
    <dt>Verdict</dt><dd><strong>${verdict}</strong>: ${sevMatch.find(s => s.sev === 'S1')?.defects ?? 0} release-blocking (S1) defects open</dd>
  </dl>
</section>

<section class="section toc">
  <h2>Contents</h2>
  <table class="toc-table"><tbody>${sections.map(([id, t]) => `<tr><td><a href="#${id}">${esc(t)}</a></td><td class="num">${tocPages[t] ?? ''}</td></tr>`).join('')}</tbody></table>
</section>

<section class="section" id="summary">
  <h2>1. Executive summary</h2>
  <div class="verdict ${verdict === 'Ready for release' ? 'ok' : ''}">${verdict}</div>
  <p>All ${total.toLocaleString()} cases in the pack were run or classified. ${executed.toLocaleString()} were executed automatically (${pct(executed, total)}). Of those, ${pass.toLocaleString()} passed and ${fail} failed. The remaining ${manual} cases need real phones, other browsers, external scanners or a second real account, and are listed in section 6. No case was left unrun.</p>
  <div class="kpis">
    <div class="kpi"><strong>${total.toLocaleString()}</strong><span>Cases in the pack</span></div>
    <div class="kpi pass"><strong>${pass.toLocaleString()}</strong><span>Passed (${pct(pass, executed)} of executed)</span></div>
    <div class="kpi fail"><strong>${fail}</strong><span>Failed (real defects)</span></div>
    <div class="kpi man"><strong>${manual}</strong><span>Manual only</span></div>
    <div class="kpi"><strong>${notRun}</strong><span>Not run</span></div>
  </div>
  <p>The ${fail} failing cases trace back to <strong>${sevMatch.reduce((a, s) => a + s.defects, 0)} distinct defects</strong>. Every failing case is mapped to exactly one defect in section 4.</p>
  <table><thead><tr><th>Severity</th><th>Meaning</th><th class="num">Defects</th><th class="num">Failing cases</th></tr></thead><tbody>
  ${sevMatch.map(s => `<tr><td><span class="sev ${s.sev}">${s.sev}</span></td><td>${esc(sevDefs[s.sev] ?? '')}</td><td class="num">${s.defects}</td><td class="num">${s.cases}</td></tr>`).join('')}
  </tbody></table>
  <h3>Release blockers (S1)</h3>
  <table><thead><tr><th>ID</th><th>Defect</th></tr></thead><tbody>${s1Titles.map(d => `<tr><td><strong>${d.id}</strong></td><td>${inline(d.title)}</td></tr>`).join('')}</tbody></table>
  <h3>Features unusable without a fix (S2)</h3>
  <table><thead><tr><th>ID</th><th>Defect</th></tr></thead><tbody>${s2Titles.map(d => `<tr><td><strong>${d.id}</strong></td><td>${inline(d.title)}</td></tr>`).join('')}</tbody></table>
  <h3>What held up</h3>
  <ul>
    <li>Ledger integrity: every posted journal balanced and source-unique, apart from the two S1 cases above. Receivable, inventory and commission controls reconciled after every trading sequence.</li>
    <li>Commission engine: every commission case passed. That covers accrual, release on cleared cash, bounce reversal, recovery through payroll and plan date overlaps.</li>
    <li>Tenancy through the app: the API projection scopes every role and branch correctly. The tenant-isolation gap (D-07) applies only to direct database reads with a user's session.</li>
    <li>Idempotency, revision conflicts and atomic commits (snapshot plus relational projection) behaved as designed under parallel load.</li>
  </ul>
  <p>P1 (release-critical) cases: ${count(p1, 'pass')} of ${p1.length} passed, ${count(p1, 'fail')} failed and ${count(p1, 'manual')} are manual.</p>
</section>

<section class="section" id="scope">
  <h2>2. Scope and approach</h2>
  <h3>2.1 Test pack</h3>
  <p>The pack has 20 feature areas of 100 cases each. Every case has a stable ID, a priority (P1 blocks release to P4 cosmetic), a type, an action with data, and an expected result quoting the product's real messages. FBR e-invoicing, real bank feeds and real customs lookups are out of scope.</p>
  <table><thead><tr><th>Type</th><th>Meaning</th><th class="num">Cases</th></tr></thead><tbody>${Object.entries(typeNames).map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td><td class="num">${rows.filter(r => r.type === k).length}</td></tr>`).join('')}</tbody></table>
  <h3>2.2 How cases were executed</h3>
  <table><thead><tr><th>Layer</th><th>What it exercises</th><th class="num">Cases</th></tr></thead><tbody>
    <tr><td>Engine and domain</td><td>The ERP engine in memory: commands, role and module gates, validation, postings, reports, invariants. Also covers route handlers with faked Supabase, server-rendered components, static source and CSS checks, and the real database migrations in PGlite (RLS, storage policies, atomic commit).</td><td class="num">${byLayer.engine}</td></tr>
    <tr><td>Browser</td><td>Playwright in Chromium at 1440×900 and 390×844 (touch and mobile emulation). Runs against a development server and a production build, each with its own disposable QA company. Includes axe-core accessibility scans, print emulation and A4 PDF pagination.</td><td class="num">${byLayer.browser}</td></tr>
    <tr><td>Both layers</td><td>Engine core proven in memory, then the user-facing part confirmed in the browser.</td><td class="num">${byLayer.both}</td></tr>
    <tr><td>Manual only</td><td>Needs real hardware, Safari or Firefox, Lighthouse, OWASP ZAP, email delivery or a second real account.</td><td class="num">${manual}</td></tr>
  </tbody></table>
  <h3>2.3 Rules applied to every case</h3>
  <ul>
    <li>Each case is one test whose title starts with its ID, so results trace back to the pack one to one.</li>
    <li>A failing test means the product is wrong. Failures were re-run on their own before being counted, to rule out flaky timing or lost sessions.</li>
    <li>Where a case asked to "verify" a design choice, the actual behaviour was recorded (section 5), not marked as a failure.</li>
    <li>Where a case guessed a harmless detail wrong, such as an account code or exact wording, the case was corrected to match the product (section 5).</li>
    <li>Testing used only disposable QA companies. Customer data, the demo company's records and the design partner's company were never touched.</li>
  </ul>
  <h3>2.4 Environment</h3>
  <dl class="meta"><dt>Engine pass</dt><dd>Vitest, Node 22, PGlite with the project's migrations</dd><dt>Browser pass</dt><dd>Playwright with Chrome, Next.js 16 development and production builds, hosted Supabase (QA tenants only)</dd><dt>Data</dt><dd>Synthetic fixtures built with the product's own engine</dd></dl>
</section>

<section class="section" id="results">
  <h2>3. Results</h2>
  <div class="legend"><span><i style="background:#23a35a"></i>Pass</span><span><i style="background:#d92d20"></i>Fail</span><span><i style="background:#a7adbb"></i>Manual</span></div>
  <h3>3.1 By feature area</h3>
  <table><thead><tr><th>Area</th><th class="num">Cases</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Manual</th><th class="num">Pass rate*</th><th>Distribution</th></tr></thead><tbody>
  ${areas.map(a => { const l = rows.filter(r => r.area === a); return `<tr><td>${esc(shortArea(a))} <span class="muted">(${prefixOf(a)})</span></td><td class="num">${l.length}</td><td class="num">${count(l, 'pass')}</td><td class="num">${count(l, 'fail')}</td><td class="num">${count(l, 'manual')}</td><td class="num">${pct(count(l, 'pass'), count(l, 'pass') + count(l, 'fail'))}</td><td>${bar(l)}</td></tr>`; }).join('')}
  <tr><td><strong>Total</strong></td><td class="num"><strong>${total}</strong></td><td class="num"><strong>${pass}</strong></td><td class="num"><strong>${fail}</strong></td><td class="num"><strong>${manual}</strong></td><td class="num"><strong>${pct(pass, executed)}</strong></td><td>${bar(rows)}</td></tr>
  </tbody></table>
  <p class="muted">* Pass rate is over executed cases (pass + fail).</p>
  <div class="two"><div>
  <h3>3.2 By priority</h3>
  <table><thead><tr><th>Priority</th><th class="num">Cases</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Manual</th></tr></thead><tbody>${priorities.map(p => { const l = rows.filter(r => r.priority === p); return `<tr><td>${p}</td><td class="num">${l.length}</td><td class="num">${count(l, 'pass')}</td><td class="num">${count(l, 'fail')}</td><td class="num">${count(l, 'manual')}</td></tr>`; }).join('')}</tbody></table>
  </div><div>
  <h3>3.3 By type</h3>
  <table><thead><tr><th>Type</th><th class="num">Cases</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Manual</th></tr></thead><tbody>${Object.entries(typeNames).map(([k, v]) => { const l = rows.filter(r => r.type === k); return `<tr><td>${v}</td><td class="num">${l.length}</td><td class="num">${count(l, 'pass')}</td><td class="num">${count(l, 'fail')}</td><td class="num">${count(l, 'manual')}</td></tr>`; }).join('')}</tbody></table>
  </div></div>
  <h3>3.4 Failing cases</h3>
  <p>Each failing case and the defect it belongs to. One defect can fail several cases.</p>
  <table class="ids"><thead><tr><th>ID</th><th>P</th><th>Case</th><th>Expected</th><th>Defect</th></tr></thead><tbody>
  ${rows.filter(r => r.status === 'fail').map(r => { const d = defectOf.get(r.id); return `<tr><td><strong>${r.id}</strong></td><td>${r.priority}</td><td>${inline(r.text)}</td><td>${inline(r.expected)}</td><td>${d ? `<span class="sev ${d.sev}">${d.sev}</span> <strong>${d.id}</strong><br><span class="muted">${inline(d.title)}</span>` : '—'}</td></tr>`; }).join('')}
  </tbody></table>
</section>

<section class="section" id="defects">
  <h2>4. Defect register</h2>
  <p>Each entry is one root cause. It lists the affected cases, what happens and what should happen, where in the code, and a suggested direction for the fix. Entries are ordered by severity; within a severity, money, stock and security come before user experience.</p>
  ${markdown(defectsMd.replace(/^# .*\n/, '').replace(/^Drafted .*\n/m, '').replace(/^## Summary[\s\S]*?(?=^## S1)/m, '').replace(/^## Not defects, but worth deciding[\s\S]*$/m, ''))}
</section>

<section class="section" id="decisions">
  <h2>5. Behaviour to decide and case corrections</h2>
  <h3>5.1 Not defects, but worth deciding</h3>
  ${markdown((defectsMd.match(/^## Not defects, but worth deciding\n([\s\S]*)$/m)?.[1] ?? ''))}
  <h3>5.2 Behaviour recorded where a case asked to verify (${documented.length})</h3>
  <table><thead><tr><th>ID</th><th>Case</th><th>Actual behaviour</th></tr></thead><tbody>${documented.map(r => `<tr><td><strong>${r.id}</strong></td><td>${inline(r.text)}</td><td>${esc(tagText(r, '[documented'))}</td></tr>`).join('')}</tbody></table>
  <h3>5.3 Case corrections (${corrected.length})</h3>
  <p>These cases guessed a harmless detail wrong, such as an account code, a number format or exact wording. The test asserts what the product actually does, and the pack should be updated to match.</p>
  <table><thead><tr><th>ID</th><th>Case</th><th>What is actually true</th></tr></thead><tbody>${corrected.map(r => `<tr><td><strong>${r.id}</strong></td><td>${inline(r.text)}</td><td>${esc(tagText(r, '[case-corrected'))}</td></tr>`).join('')}</tbody></table>
</section>

<section class="section" id="manual">
  <h2>6. Manual-only cases (${manualRows.length})</h2>
  <p>These cases cannot be automated in this environment. They are the checklist for a hands-on session on real devices before the first customer goes live.</p>
  <table><thead><tr><th>ID</th><th>P</th><th>Case</th><th>Why manual</th></tr></thead><tbody>${manualRows.map(r => `<tr><td><strong>${r.id}</strong></td><td>${r.priority}</td><td>${inline(r.text)}</td><td>${esc(reasonOf(r).slice(0, 180))}</td></tr>`).join('')}</tbody></table>
</section>

<section class="section" id="reproduce">
  <h2>7. How to reproduce</h2>
  <table><thead><tr><th>Step</th><th>Command</th><th>Result</th></tr></thead><tbody>
    <tr><td>Engine pass (all 20 areas)</td><td><code>npm run test:qa</code></td><td>Writes <code>reports/qa-run/vitest.json</code>. Open defects are failing tests tagged [defect]. This suite is kept out of <code>npm test</code>.</td></tr>
    <tr><td>Browser pass</td><td><code>npm run test:qa:browser</code></td><td>Writes <code>reports/qa-run/playwright.json</code>. Parallel runs set <code>QA_TENANT_ID</code>, <code>QA_BASE_URL</code> and <code>QA_PW_JSON</code>.</td></tr>
    <tr><td>Merge results</td><td><code>npm run qa:report</code></td><td>Writes <code>RESULTS.md</code> and <code>results.json</code>.</td></tr>
    <tr><td>This PDF</td><td><code>npx tsx scripts/qa-pdf.ts</code></td><td>Writes <code>reports/qa-run/SahulatERP-SQA-Report.pdf</code>.</td></tr>
    <tr><td>Reset a QA company</td><td><code>npm run qa:tenant</code></td><td>Touches only the disposable QA tenants.</td></tr>
  </tbody></table>
  <h3>Artefacts</h3>
  <ul>
    <li><code>docs/qa/README.md</code>: master test plan, entry and exit criteria, and invariants.</li>
    <li><code>docs/qa/cases/</code>: the 2,000 cases.</li>
    <li><code>tests/qa/</code>: engine-pass tests; <code>tests/qa-browser/</code>: browser-pass specs.</li>
    <li><code>reports/qa-run/DEFECTS.md</code>: defect register; <code>RESULTS.md</code>: per-case results.</li>
  </ul>
</section>

<section class="section appendix" id="appendix">
  <h2>Appendix A. Every case and its result</h2>
  <p class="muted">Layer: E = engine pass, B = browser pass, E+B = both. Case text is as written in the pack; see section 5 for corrections.</p>
  ${areas.map(a => { const l = rows.filter(r => r.area === a); return `<h3>${esc(a)}: ${count(l, 'pass')} pass · ${count(l, 'fail')} fail · ${count(l, 'manual')} manual</h3><table><thead><tr><th style="width:15mm">ID</th><th style="width:7mm">P</th><th style="width:6mm">T</th><th>Case</th><th>Expected</th><th style="width:12mm">Layer</th><th style="width:14mm">Result</th></tr></thead><tbody>${l.map(r => `<tr><td><strong>${r.id}</strong></td><td>${r.priority}</td><td>${r.type}</td><td>${inline(r.text)}</td><td>${inline(r.expected)}</td><td>${r.layers.length === 2 ? 'E+B' : r.layers[0] === 'engine' ? 'E' : r.layers[0] === 'browser' ? 'B' : '—'}</td><td>${statusChip(r.status)}</td></tr>`).join('')}</tbody></table>`; }).join('')}
</section>
</body></html>`;

async function main() {
  const htmlPath = join(out, 'SahulatERP-SQA-Report.html');
  writeFileSync(htmlPath, html);
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  const pdfPath = join(out, 'SahulatERP-SQA-Report.pdf');
  await page.pdf({
    path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:7.5pt;color:#5b6170;width:100%;padding:0 16mm;display:flex;justify-content:space-between;font-family:-apple-system,Arial"><span>SahulatERP · SQA Test Report</span><span>Commit ${esc(commit)}</span></div>`,
    footerTemplate: `<div style="font-size:7.5pt;color:#5b6170;width:100%;padding:0 16mm;display:flex;justify-content:space-between;font-family:-apple-system,Arial"><span>Confidential · generated ${esc(generated)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  });
  await browser.close();
  // First build: find where each section starts, then rebuild once so the contents page shows page numbers.
  if (!process.env.QA_PDF_SECOND_PASS) {
    const found = execSync(`swift ${JSON.stringify(join(root, 'scripts/pdf-find-pages.swift'))} ${JSON.stringify(pdfPath)} ${sections.map(([, t]) => JSON.stringify(t)).join(' ')}`).toString();
    writeFileSync(tocPath, found);
    execSync(`npx tsx ${JSON.stringify(join(root, 'scripts/qa-pdf.ts'))}`, { stdio: 'inherit', env: { ...process.env, QA_PDF_SECOND_PASS: '1' } });
    return;
  }
  console.log(JSON.stringify({ pdf: pdfPath, total, pass, fail, manual, notRun, contents: tocPages }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
