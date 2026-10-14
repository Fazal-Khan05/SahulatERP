import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { F, PHONE, QA_TENANT, freshBuilder, gotoApp, home, keepSignedIn, openModule, readWorkspaceApi, saveEvidence, sharedSession, signedInPage, writeQaWorkspace } from './helpers';
import type { Workspace } from '../../src/modules/erp/types';

// Printing in a real browser: rendered layout, @media print, Chromium PDF pagination (page.pdf) and the in-app details dialog.
// Every describe block writes the company it needs into the QA tenant first.

const A4_CONTENT = { width: 688, height: 1009 }; // 210×297 mm minus the 14 mm side/top and 16 mm bottom @page margins, in CSS px.
const LONG_COMPANY = 'Al-Noor Consolidated Importers, Distributors & General Order Suppliers of Electrical and Household Goods (Private) Ltd'.padEnd(120, '.');
const FOOTER = Array.from({ length: 8 }, (_, i) => `Clause ${i + 1}: goods once sold are returnable within seven days with the original invoice, in unused condition, at the customer's cost.`).join(' ').slice(0, 500);
const NOTES = Array.from({ length: 40 }, (_, i) => `Note ${String(i + 1).padStart(2, '0')}: deliver to the back gate before noon and call the store manager first.`).join(' ').slice(0, 2000);
const LONG_ITEM = 'Rechargeable LED Emergency Panel Light with Lithium Battery Backup, Aluminium Housing and Wall Mount Bracket Kit, 2x18W'.padEnd(120, '.');
const URDU = 'علی ٹریڈرز';

/** A company with 100 one-line products and invoices of 10, 60 and 100 lines; `extreme` adds the long-content cases. */
function printWorkspace(extreme = false) {
  const b = freshBuilder(undefined, extreme ? { name: LONG_COMPANY } : {});
  b.run('save_branding', { ...b.w.branding, accent: '#1f5fa8', footer: extreme ? FOOTER : 'Bank: QA Bank · Account 000-111' });
  const items = Array.from({ length: 100 }, (_, i) => b.item({ sku: `P${String(i + 1).padStart(3, '0')}`, name: `Line product ${String(i + 1).padStart(3, '0')}`, price: '100', cost: '60' }, '1000', '60'));
  const longItem = b.item({ sku: 'LONG-1', name: LONG_ITEM, price: '2400', cost: '1450' }, '100', '1450');
  const cust = b.party(F.customer, 'customer');
  const urdu = b.party(URDU, 'customer', { city: 'کراچی' });
  const lines = (n: number) => items.slice(0, n).map((itemId, i) => ({ itemId, quantity: String(i + 1), price: '100' }));
  const ids = {
    inv10: b.doc('sales_invoice', cust, lines(10)),
    inv60: b.doc('sales_invoice', cust, lines(60)),
    inv100: b.doc('sales_invoice', cust, lines(100)),
    invLong: b.doc('sales_invoice', cust, [{ itemId: longItem, quantity: '2', price: '2400' }], { notes: NOTES }),
    invUrdu: b.doc('sales_invoice', urdu, [{ itemId: items[0], quantity: '1', price: '100' }]),
  };
  return { w: b.w, ids, number: (id: string) => b.number(id) };
}
type PrintFixture = ReturnType<typeof printWorkspace>;
const printUrl = (id: string, kind = 'sales_invoice') => `/print/${kind}/${id}?tenant=${QA_TENANT}`;
async function openPrint(page: Page, id: string, kind = 'sales_invoice') {
  await page.goto(printUrl(id, kind));
  await page.waitForLoadState('networkidle');
  await expect(page.locator('article.doc')).toBeVisible();
}
/** Expected row text in the extracted PDF for line i of the fixture invoices ("Line product 012" · SKU · qty · rate · disc · tax · amount). */
const rowText = (i: number) => { const n = String(i).padStart(3, '0'); return `Line product ${n}P${n}${i} pcsRs 1000%0%Rs ${(i * 100).toLocaleString('en-US')}`; };
const sumTo = (n: number) => `Rs ${(n * (n + 1) * 50).toLocaleString('en-US')}`;

/**
 * Minimal reader for Chromium (Skia) PDFs: walks the objects, inflates streams, maps each page's
 * Identity-H glyph strings back to text through the fonts' ToUnicode CMaps. Returns one string per page.
 */
function pdfPages(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const objs = new Map<number, { dict: string; stream?: Buffer }>();
  const head = /(\d+) 0 obj/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(s))) {
    const start = m.index + m[0].length;
    const streamAt = s.indexOf('stream', start), endAt = s.indexOf('endobj', start);
    if (streamAt !== -1 && streamAt < endAt) {
      const dict = s.slice(start, streamAt);
      let dataAt = streamAt + 6; if (s[dataAt] === '\r') dataAt++; if (s[dataAt] === '\n') dataAt++;
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      const raw = pdf.subarray(dataAt, dataAt + length);
      let stream: Buffer = raw; if (/FlateDecode/.test(dict)) { try { stream = inflateSync(raw); } catch { /* not needed */ } }
      objs.set(Number(m[1]), { dict, stream });
      head.lastIndex = dataAt + length;
    } else objs.set(Number(m[1]), { dict: s.slice(start, endAt) });
  }
  const ref = (dict: string, key: string) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(dict)?.[1]);
  const cmaps = new Map<number, Map<number, string>>();
  const cmapOf = (font: number) => {
    if (!cmaps.has(font)) {
      const map = new Map<number, string>();
      const text = objs.get(ref(objs.get(font)?.dict ?? '', 'ToUnicode'))?.stream?.toString('latin1') ?? '';
      const hex = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(x => parseInt(x, 16)));
      for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), hex(p[2]));
      for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const [a, b, d] = [p[1], p[2], p[3]].map(x => parseInt(x, 16)); for (let c = a; c <= b; c++) map.set(c, String.fromCodePoint(d + c - a));
      }
      cmaps.set(font, map);
    }
    return cmaps.get(font)!;
  };
  return [...objs.values()].filter(o => /\/Type \/Page\b/.test(o.dict)).map(page => {
    const fonts = Object.fromEntries([...page.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(x => [x[1], Number(x[2])]));
    const content = objs.get(ref(page.dict, 'Contents'))?.stream?.toString('latin1') ?? '';
    let map = new Map<number, string>(); let text = '';
    for (const t of content.matchAll(/\/(F\d+) [\d.]+ Tf|<([0-9a-fA-F]*)>/g)) {
      if (t[1]) map = cmapOf(fonts[t[1]]);
      else for (let i = 0; i < t[2].length; i += 4) text += map.get(parseInt(t[2].slice(i, i + 4), 16)) ?? '';
    }
    return text;
  });
}
/** Elements of the printed document that stick out past its right edge in the current layout. */
const overflowRight = (page: Page) => page.evaluate(() => {
  const doc = document.querySelector('article.doc')!.getBoundingClientRect();
  return [...document.querySelectorAll('article.doc *')].map(e => ({ e, r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.right > doc.right + 0.5)
    .map(x => `${x.e.tagName.toLowerCase()}.${(x.e as HTMLElement).className || ''} right=${Math.round(x.r.right)} > ${Math.round(doc.right)} "${(x.e.textContent ?? '').slice(0, 30)}"`).slice(0, 6);
});
/** Lays the page out as Chromium prints it on A4: print media at the printable width. */
async function a4PrintLayout(page: Page) {
  await page.setViewportSize(A4_CONTENT);
  await page.emulateMedia({ media: 'print' });
}
/** Fonts Chromium actually used to draw a node's text (CDP), to catch missing-glyph fallbacks. */
async function platformFonts(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  } finally { await cdp.detach(); }
}
type PrintCounter = Window & { __prints: number };
const stubPrint = (page: Page) => page.addInitScript(() => { (window as unknown as PrintCounter).__prints = 0; window.print = () => { (window as unknown as PrintCounter).__prints++; }; });
const printCalls = (page: Page) => page.evaluate(() => (window as unknown as PrintCounter).__prints);

// ====================================================================== standard company, 10/60/100-line invoices
test.describe('print page and A4 output', () => {
  let fx: PrintFixture;
  let context: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    fx = printWorkspace();
    await writeQaWorkspace(fx.w);
    ({ context } = await signedInPage(browser));
  });
  test.beforeEach(async ({ browser }) => { await keepSignedIn(browser, context); });
  test.afterAll(async () => { await context?.close(); });

  test('PRN-038 "Print / Save as PDF" opens browser print; the button is hidden in print output', async () => {
    const tab = await context.newPage();
    await stubPrint(tab);
    await openPrint(tab, fx.ids.inv10);
    const button = tab.getByRole('button', { name: 'Print / Save as PDF' });
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(() => printCalls(tab)).toBe(1);
    await tab.emulateMedia({ media: 'print' });
    await expect(button).toBeHidden();
    await expect(tab.locator('.print-actions')).toHaveCSS('display', 'none');
    const text = pdfPages(await tab.pdf({ format: 'A4' })).join('');
    expect(text).toContain(fx.number(fx.ids.inv10));
    expect(text).not.toContain('Print / Save as PDF');
    await tab.close();
  });

  test('PRN-039 A4 portrait: 10 lines fit one page; 60 lines break across pages without splitting a row [defect]', async () => {
    const tab = await context.newPage();
    await openPrint(tab, fx.ids.inv60);
    const sixty = pdfPages(await tab.pdf({ format: 'A4' }));
    expect(sixty.length).toBeGreaterThan(1);
    for (let i = 1; i <= 60; i++) expect(sixty.filter(p => p.includes(rowText(i))), `row ${i} printed whole on exactly one page`).toHaveLength(1);
    expect(sixty.slice(1).every(p => p.startsWith('DESCRIPTIONQTYRATEDISC.TAXAMOUNT')), 'table header repeated on continuation pages').toBe(true);
    await openPrint(tab, fx.ids.inv10);
    const ten = pdfPages(await tab.pdf({ format: 'A4' }));
    saveEvidence('prn-039-a4-10-lines.json', ten);
    // Actual: two pages; the footer ("Bank: … Computer-generated document …") is pushed alone onto page 2.
    expect(ten, '10-line invoice fits one A4 page').toHaveLength(1);
    await tab.close();
  });

  test('PRN-040 Letter print fits: nothing cut off at the page edge, 10 lines on one page [defect]', async () => {
    const tab = await context.newPage();
    await openPrint(tab, fx.ids.inv10);
    const letter = pdfPages(await tab.pdf({ format: 'Letter' }));
    saveEvidence('prn-040-letter-10-lines.json', letter);
    const text = letter.join('');
    for (let i = 1; i <= 10; i++) expect(text).toContain(rowText(i));
    // Actual: the totals table is 100% wide (globals.css `table{width:100%}`) beside the notes column, so the amounts
    // run past the right margin and Chromium clips them ("Balance dueRs " with no figure).
    expect.soft(text, 'totals amounts printed in full').toContain(`Balance due${sumTo(10)}`);
    expect.soft(letter, '10-line invoice fits one Letter page').toHaveLength(1);
    await tab.setViewportSize({ width: 763, height: 950 }); // Letter 8.5 in minus the 14 mm side margins
    await tab.emulateMedia({ media: 'print' });
    expect(await overflowRight(tab)).toEqual([]);
    await tab.close();
  });

  test('PRN-044 100-line invoice paginates; totals on the last page [defect]', async () => {
    const tab = await context.newPage();
    await openPrint(tab, fx.ids.inv100);
    const pages = pdfPages(await tab.pdf({ format: 'A4' }));
    saveEvidence('prn-044-a4-100-lines.json', pages);
    expect(pages.length).toBeGreaterThan(2);
    for (let i = 1; i <= 100; i++) expect(pages.filter(p => p.includes(rowText(i))), `row ${i}`).toHaveLength(1);
    expect(pages.filter(p => p.includes('Balance due')), 'totals printed once').toHaveLength(1);
    // Actual: totals sit on the second-last page with the amount clipped; the last page holds only the footer.
    expect(pages.at(-1), 'last page carries the totals with the full balance').toContain(`Balance due${sumTo(100)}`);
    await tab.close();
  });

  test('PRN-075 Save as PDF filename suggestion [documented: Chromium names the PDF after the tab title, which stays "SahulatERP · Your business, connected"; PrintActions\' "Sales invoice <number>" title is not applied]', async () => {
    const tab = await context.newPage();
    await openPrint(tab, fx.ids.inv10);
    await tab.waitForTimeout(1000);
    const title = await tab.title();
    // The case accepts the browser default; record which one the browser actually suggests.
    expect([`Sales invoice ${fx.number(fx.ids.inv10)}`, 'SahulatERP · Your business, connected']).toContain(title);
    expect(title).toBe('SahulatERP · Your business, connected');
    const pdfTitle = /\/Title <FEFF([0-9A-F]+)>/.exec((await tab.pdf()).toString('latin1'))?.[1] ?? '';
    expect(String.fromCharCode(...(pdfTitle.match(/.{4}/g) ?? []).map(h => parseInt(h, 16)))).toBe(title);
    await tab.close();
  });

  test('PRN-076 print page loads in under 1.5 s (median of 3 warm loads)', async () => {
    const tab = await context.newPage();
    await openPrint(tab, fx.ids.inv10);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      await openPrint(tab, fx.ids.inv10);
      times.push(await tab.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd));
    }
    times.sort((a, b) => a - b);
    saveEvidence('prn-076-print-load-ms.json', times);
    expect(times[1]).toBeLessThan(1500);
    await tab.close();
  });

  test('PRN-083 Ctrl/Cmd+P gives the same output [documented: headless Chromium cannot show the native dialog; the page leaves the shortcut to the browser (keydown not prevented) and the browser prints the same @media print output the button uses]', async () => {
    const tab = await context.newPage();
    await tab.addInitScript(() => {
      const w = window as unknown as { __keys: string[] };
      w.__keys = [];
      window.addEventListener('keydown', e => { if (e.key === 'p') setTimeout(() => w.__keys.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}p:${e.defaultPrevented}`)); }, true);
    });
    const errors: string[] = [];
    tab.on('pageerror', e => errors.push(e.message));
    await openPrint(tab, fx.ids.inv10);
    await tab.keyboard.press('Control+p');
    await tab.keyboard.press('Meta+p');
    await expect.poll(() => tab.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toEqual(['Ctrl+p:false', 'Meta+p:false']);
    expect(errors).toEqual([]);
    const viaShortcut = pdfPages(await tab.pdf({ format: 'A4' })).join('');
    await tab.evaluate(() => { window.print = () => undefined; });
    await tab.getByRole('button', { name: 'Print / Save as PDF' }).click();
    expect(pdfPages(await tab.pdf({ format: 'A4' })).join('')).toBe(viaShortcut);
    await tab.close();
  });

  test('PRN-087 two tabs printing different documents are independent', async () => {
    const [a, b] = [await context.newPage(), await context.newPage()];
    await Promise.all([stubPrint(a), stubPrint(b)]);
    await openPrint(a, fx.ids.inv10);
    await openPrint(b, fx.ids.inv60);
    const [na, nb] = [fx.number(fx.ids.inv10), fx.number(fx.ids.inv60)];
    await a.getByRole('button', { name: 'Print / Save as PDF' }).click();
    expect(await printCalls(a)).toBe(1);
    expect(await printCalls(b)).toBe(0);
    await expect(a.locator('.doc-title-meta')).toContainText(na);
    await expect(b.locator('.doc-title-meta')).toContainText(nb);
    const [ta, tb] = [pdfPages(await a.pdf()).join(''), pdfPages(await b.pdf()).join('')];
    expect(ta).toContain(`Number${na}`); expect(ta).not.toContain(nb); expect(ta).not.toContain(rowText(11));
    expect(tb).toContain(`Number${nb}`); expect(tb).not.toContain(na); expect(tb).toContain(rowText(60));
    await Promise.all([a.close(), b.close()]);
  });
});

// ====================================================================== long content
test.describe('long content in the print layout', () => {
  let fx: PrintFixture;
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    fx = printWorkspace(true);
    await writeQaWorkspace(fx.w);
    ({ context, page } = await signedInPage(browser));
  });
  test.beforeEach(async ({ browser }) => { await keepSignedIn(browser, context); });
  test.afterAll(async () => { await context?.close(); });
  /** Checks one layout after the other: the on-screen page at 1440 px, then the A4 print layout. */
  async function eachLayout(id: string, check: (layout: string) => Promise<void>) {
    for (const layout of ['screen', 'A4 print']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ media: 'screen' });
      await openPrint(page, id);
      if (layout === 'A4 print') await a4PrintLayout(page);
      await test.step(layout, () => check(layout));
    }
  }

  test('PRN-045 120-character product name wraps within its column [defect]', async () => {
    await eachLayout(fx.ids.invLong, async () => {
      const cell = page.locator('.doc-lines tbody td').first();
      const name = cell.locator('strong');
      await expect(name).toHaveText(LONG_ITEM);
      const box = await name.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight), ws: getComputedStyle(el).whiteSpace }));
      // Actual: the app-wide `td{white-space:nowrap}` (globals.css) reaches the print template, so the name stays on one
      // line and the lines table grows wider than the A4 sheet.
      expect(box.ws, 'description may wrap').not.toBe('nowrap');
      expect(box.sw).toBeLessThanOrEqual(box.cw);
      expect(box.h).toBeGreaterThan(box.lh * 1.5); // wrapped onto more than one line
      const [desc, qty] = await Promise.all([cell.boundingBox(), page.locator('.doc-lines tbody td').nth(1).boundingBox()]);
      expect(desc!.x + desc!.width).toBeLessThanOrEqual(qty!.x + 0.5);
      expect(await overflowRight(page)).toEqual([]);
    });
  });

  test('PRN-046 2,000-character notes wrap and are not clipped [defect]', async () => {
    await eachLayout(fx.ids.invLong, async layout => {
      const notes = page.locator('.doc-notes p');
      await expect(notes).toHaveText(NOTES);
      const m = await notes.evaluate(el => { const r = el.getBoundingClientRect(); const doc = document.querySelector('article.doc')!.getBoundingClientRect(); return { sw: el.scrollWidth, cw: el.clientWidth, width: r.width, docWidth: doc.width, left: r.left, docLeft: doc.left }; });
      saveEvidence(`prn-046-notes-${layout.replace(' ', '-')}.json`, m);
      // Actual: the totals table takes 100% of the row (globals.css `table{width:100%}`), squeezing the notes column to ~0 px.
      expect(m.width, 'notes column has room to wrap').toBeGreaterThan(m.docWidth * 0.3);
      expect(m.sw, 'notes text not clipped').toBeLessThanOrEqual(m.cw);
      expect(m.left).toBeGreaterThanOrEqual(m.docLeft);
    });
  });

  test('PRN-047 500-character footer wraps', async () => {
    await eachLayout(fx.ids.inv10, async () => {
      const footer = page.locator('.doc-footer p');
      await expect(footer).toHaveText(FOOTER);
      const m = await footer.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 16, right: el.getBoundingClientRect().right, docRight: document.querySelector('article.doc')!.getBoundingClientRect().right }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.h).toBeGreaterThan(m.lh * 1.5);
      expect(m.right).toBeLessThanOrEqual(m.docRight + 0.5);
    });
  });

  test('PRN-048 120-character company name wraps; header intact', async () => {
    await eachLayout(fx.ids.inv10, async () => {
      await expect(page.locator('.doc-company')).toHaveText(LONG_COMPANY);
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const name = document.querySelector('.doc-company')!;
        return { identity: r('.doc-identity'), title: r('.doc-title'), header: r('.doc-header'), doc: r('article.doc'), nameSw: name.scrollWidth, nameCw: name.clientWidth, nameH: name.getBoundingClientRect().height };
      });
      expect(m.nameSw).toBeLessThanOrEqual(m.nameCw);
      expect(m.nameH).toBeGreaterThan(25); // more than one line
      expect(m.identity.right <= m.title.left + 0.5 || m.identity.bottom <= m.title.top + 0.5, 'company block and title block do not overlap').toBe(true);
      expect(m.header.right).toBeLessThanOrEqual(m.doc.right + 0.5);
      await expect(page.locator('.doc-title h1')).toBeVisible();
      await expect(page.locator('.doc-title-meta')).toContainText(fx.number(fx.ids.inv10));
    });
  });

  test('PRN-049 Urdu party name renders right-to-left with real glyphs', async () => {
    await eachLayout(fx.ids.invUrdu, async () => {
      const party = page.locator('.doc-parties strong');
      await expect(party).toHaveText(URDU);
      // Visual order: the first logical letter (ع) sits right of the last (ز).
      const xs = await party.evaluate(el => {
        const text = el.firstChild!; const range = document.createRange();
        const at = (i: number) => { range.setStart(text, i); range.setEnd(text, i + 1); return range.getBoundingClientRect(); };
        return { first: at(0).left, last: at((text.textContent ?? '').length - 1).left };
      });
      expect(xs.first).toBeGreaterThan(xs.last);
      const fonts = await platformFonts(page, '.doc-parties strong');
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.map(f => f.familyName)).not.toContain('LastResort');
      expect(fonts.reduce((n, f) => n + f.glyphCount, 0)).toBeGreaterThanOrEqual(URDU.replace(/\s/g, '').length - 2);
      await expect(page.locator('.doc-parties')).toContainText('کراچی');
    });
  });
});

// ====================================================================== logos
test.describe('uploaded logos in the printed header', () => {
  let fx: PrintFixture;
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    fx = printWorkspace();
    await writeQaWorkspace(fx.w);
    ({ context, page } = await signedInPage(browser));
  });
  test.beforeEach(async ({ browser }) => { await keepSignedIn(browser, context); });
  test.afterAll(async () => { await context?.close(); });

  async function uploadLogo(png: Buffer) {
    const response = await context.request.post('/api/branding/upload', { headers: { 'x-tenant-id': QA_TENANT }, multipart: { kind: 'logo', file: { name: 'logo.png', mimeType: 'image/png', buffer: png } } });
    expect(response.status(), await response.text()).toBe(200);
  }
  async function logoLayout() {
    await openPrint(page, fx.ids.inv10);
    const img = page.locator('img.doc-logo');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    return page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect;
      const img = document.querySelector('img.doc-logo') as HTMLImageElement;
      return { natural: [img.naturalWidth, img.naturalHeight], box: r('img.doc-logo'), fit: getComputedStyle(img).objectFit, company: r('.doc-company'), header: r('.doc-header'), title: r('.doc-title'), doc: r('article.doc') };
    });
  }
  const mm22 = 22 * 96 / 25.4;

  test('PRN-051 1×1 px logo scales into the logo box without breaking the header', async () => {
    await uploadLogo(await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 31, g: 95, b: 168, alpha: 1 } } }).png().toBuffer());
    const m = await logoLayout();
    expect(m.natural).toEqual([1, 1]);
    expect(Math.abs(m.box.width - mm22)).toBeLessThan(1);
    expect(Math.abs(m.box.height - mm22)).toBeLessThan(1);
    expect(m.fit).toBe('contain');
    expect(m.company.left).toBeGreaterThanOrEqual(m.box.right);
    expect(m.box.bottom).toBeLessThanOrEqual(m.header.bottom);
    expect(m.header.right).toBeLessThanOrEqual(m.doc.right);
  });

  test('PRN-052 very wide 2000×100 logo is constrained to the logo box', async () => {
    await uploadLogo(await sharp({ create: { width: 2000, height: 100, channels: 4, background: { r: 21, g: 34, b: 52, alpha: 1 } } }).png().toBuffer());
    const m = await logoLayout();
    expect(m.natural).toEqual([2000, 100]);
    expect(m.box.width).toBeLessThanOrEqual(mm22 + 1);
    expect(m.box.height).toBeLessThanOrEqual(mm22 + 1);
    expect(m.fit).toBe('contain');
    expect(m.company.left).toBeGreaterThanOrEqual(m.box.right);
    expect(m.title.left).toBeGreaterThan(m.company.left);
    expect(m.header.right).toBeLessThanOrEqual(m.doc.right);
  });

  test('PRN-053 transparent PNG logo is readable [case-corrected: the logo sits on the white document header, not on an accent background]', async () => {
    const size = 120;
    const raw = Buffer.alloc(size * size * 4); // fully transparent
    for (let y = 30; y < 90; y++) for (let x = 20; x < 100; x++) if ((x - 20) % 20 < 12) raw.set([21, 34, 52, 255], (y * size + x) * 4);
    await uploadLogo(await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
    await logoLayout();
    const img = page.locator('img.doc-logo');
    const behind = await img.evaluate(el => { let n: Element | null = el; while (n && getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)') n = n.parentElement; return n ? getComputedStyle(n).backgroundColor : ''; });
    expect(behind).toBe('rgb(255, 255, 255)');
    const { data, info } = await sharp(await img.screenshot()).raw().toBuffer({ resolveWithObject: true });
    let dark = 0, light = 0;
    for (let i = 0; i < data.length; i += info.channels) { const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; if (lum < 80) dark++; else if (lum > 240) light++; }
    const total = data.length / info.channels;
    expect(dark / total).toBeGreaterThan(0.15); // the dark mark is drawn
    expect(light / total).toBeGreaterThan(0.3); // on a light backdrop, so it reads
  });
});

// ====================================================================== in-app details dialog (busy importer fixture)
test.describe('document details dialog', () => {
  let s: Awaited<ReturnType<typeof sharedSession>>;
  let w: Workspace;
  test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); w = await readWorkspaceApi(s.context.request); });
  test.beforeEach(async ({ browser }) => { await keepSignedIn(browser, s.context, s.page); });
  test.afterAll(async () => { await s?.context.close(); });
  const num = (id: string) => w.documents.find(d => d.id === id)!.number;
  const details = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.invoice-heading') });
  type Details = ReturnType<typeof details>;
  const section = (d: Details, heading: string) => d.locator('section').filter({ has: d.page().getByRole('heading', { name: heading, exact: true }) });
  const viewButton = (page: Page, number: string) => page.locator('section.card').first().locator('tbody tr').filter({ has: page.getByRole('cell', { name: number, exact: true }) }).getByRole('button', { name: /^View / });
  async function openDetails(page: Page, id: string) {
    const doc = w.documents.find(d => d.id === id)!;
    const sales = ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'].includes(doc.kind);
    await home(page);
    await openModule(page, sales ? 'Sales' : 'Purchasing');
    await viewButton(page, doc.number).click();
    await expect(details(page)).toBeVisible();
    await expect(details(page).locator('.invoice-heading h2, .invoice-heading [id]').first()).toContainText(doc.number);
    return details(page);
  }

  test('PRN-056 details show the QUO → SO → DN → INV chain and its links open each document [defect]', async () => {
    const { page } = s;
    const [quo, so, dn, inv] = [s.ids.quo, s.ids.so, s.ids.dn, s.ids.chainInv].map(num);
    let dialog = await openDetails(page, s.ids.so);
    await expect(section(dialog, 'Document chain')).toContainText(quo);
    await expect(section(dialog, 'Document chain')).toContainText(dn);
    await expect(dialog.locator('.invoice-meta')).toContainText(`Source${quo}`);
    dialog = await openDetails(page, s.ids.dn);
    await expect(section(dialog, 'Document chain')).toContainText(so);
    await expect(section(dialog, 'Document chain')).toContainText(inv);
    // "Links work": a chain row should open the linked document. Actual: plain text rows, nothing to click.
    const target = section(dialog, 'Document chain').locator('.invoice-related-row').filter({ hasText: inv });
    await expect(target.locator('a, button'), 'chain row is a link').toHaveCount(1);
    await target.locator('a, button').click();
    await expect(details(page)).toContainText(`Invoice ${inv}`);
  });

  test('PRN-057 details list payments with cheque status', async () => {
    const { page } = s;
    const rn = (id: string) => w.receipts.find(r => r.id === id)!.number;
    let dialog = await openDetails(page, s.ids.inv1);
    await expect(section(dialog, 'Receipts').locator('.invoice-related-row').filter({ hasText: rn(s.ids.bankRcpt) })).toContainText('bank');
    await expect(section(dialog, 'Receipts').locator('.invoice-related-row').filter({ hasText: rn(s.ids.chqBounced) })).toContainText('cheque · CHQ-1004 · bounced');
    dialog = await openDetails(page, s.ids.inv2);
    await expect(section(dialog, 'Receipts').locator('.invoice-related-row').filter({ hasText: rn(s.ids.chqReceived) })).toContainText('CHQ-1001 · received');
    await expect(section(dialog, 'Receipts').locator('.invoice-related-row').filter({ hasText: rn(s.ids.chqDeposited) })).toContainText('CHQ-1002 · deposited');
  });

  test('PRN-058 details list returns [documented: a return appears as its credit note in "Document chain", the line shows "1 returned" and totals show "Returns / credits"]', async () => {
    const dialog = await openDetails(s.page, s.ids.inv1);
    const cn = w.documents.find(d => d.id === s.ids.creditNote)!;
    await expect(section(dialog, 'Document chain').locator('.invoice-related-row').filter({ hasText: cn.number })).toContainText(`Credit note · ${cn.date} · submitted`);
    await expect(dialog.locator('.invoice-lines tbody tr').first()).toContainText('1 returned');
    await expect(dialog.locator('.invoice-totals')).toContainText('Returns / credits');
  });

  test('PRN-059 details Submit/Return/Convert/Print buttons follow state and role', async () => {
    const { page } = s;
    const actions = async (d: Details) => (await d.locator('.doc-actions button').allInnerTexts()).map(t => t.trim());
    let dialog = await openDetails(page, s.ids.draftInv);
    expect(await actions(dialog)).toEqual(['Edit draft', 'Submit', 'Cancel draft']);
    await expect(dialog.getByRole('link', { name: `Print ${num(s.ids.draftInv)}` })).toBeVisible();
    dialog = await openDetails(page, s.ids.inv2);
    expect(await actions(dialog)).toEqual(['Return']);
    dialog = await openDetails(page, s.ids.so); // fully delivered: nothing left to convert
    expect(await actions(dialog)).toEqual([]);
    dialog = await openDetails(page, s.ids.po2); // 4 of 10 received
    expect(await actions(dialog)).toEqual(['Receive goods']);
    await expect(dialog.getByRole('link', { name: `Print ${num(s.ids.po2)}` })).toBeVisible();
    // Read-only role: only Print remains.
    await home(page);
    await openModule(page, 'Settings');
    await page.getByRole('tab', { name: 'Access' }).click();
    await page.getByLabel('View as role').selectOption('Auditor');
    await expect(page.getByText('Previewing as Auditor')).toBeVisible();
    try {
      dialog = await openDetails(page, s.ids.draftInv);
      await expect(dialog.locator('.doc-actions')).toHaveCount(0);
      await expect(dialog.getByRole('link', { name: `Print ${num(s.ids.draftInv)}` })).toBeVisible();
      dialog = await openDetails(page, s.ids.inv2);
      await expect(dialog.locator('.doc-actions')).toHaveCount(0);
    } finally {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Exit preview' }).click();
      await expect(page.getByText('Previewing as')).toHaveCount(0);
    }
  });

  test('PRN-060 details for a walk-in invoice show the typed name', async () => {
    const dialog = await openDetails(s.page, s.ids.walkInv);
    await expect(dialog.locator('.invoice-parties section').nth(1).locator('strong')).toHaveText(F.walkIn);
  });

  test('PRN-061 details for a cancelled draft show the reason in notes', async () => {
    const dialog = await openDetails(s.page, s.ids.cancelled);
    await expect(dialog.locator('.badge')).toHaveText('cancelled');
    await expect(section(dialog, 'Notes')).toContainText('Cancelled: Customer changed mind');
  });

  test('PRN-077 print pages have no console errors (invoice, quotation, credit note, PO, bill, receipt)', async () => {
    const page = await s.context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    for (const [kind, id] of [['sales_invoice', s.ids.inv1], ['quotation', s.ids.quo], ['credit_note', s.ids.creditNote], ['purchase_order', s.ids.po], ['supplier_invoice', s.ids.bill], ['receipt', s.ids.chqBounced]] as const) {
      await openPrint(page, id, kind);
      await page.getByRole('button', { name: 'Print / Save as PDF' }).hover();
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  test('PRN-079 back from print returns to the app state [documented: Print opens a new tab; closing it leaves the app tab exactly as it was]', async () => {
    const { page, context } = s;
    await home(page);
    await openModule(page, 'Sales');
    await page.getByLabel('Document type').selectOption('sales_invoice');
    const rows = page.locator('section.card').first().locator('tbody tr');
    const rowsBefore = await rows.count();
    await viewButton(page, num(s.ids.inv1)).click();
    const dialog = details(page);
    const [popup] = await Promise.all([context.waitForEvent('page'), dialog.getByRole('link', { name: `Print ${num(s.ids.inv1)}` }).click()]);
    await popup.waitForLoadState('networkidle');
    await expect(popup.locator('.doc-title-meta')).toContainText(num(s.ids.inv1));
    expect(popup.url()).toContain(`/print/sales_invoice/${s.ids.inv1}`);
    await popup.close();
    await expect(dialog).toBeVisible();
    await expect(page.locator('.breadcrumb strong')).toHaveText('Sales');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Document type')).toHaveValue('sales_invoice');
    await expect(rows).toHaveCount(rowsBefore);
  });

  test('PRN-062 details dialog on phone is a bottom sheet that scrolls [documented: the sheet keeps 20px radius on its bottom corners too — globals.css `.dialog-content{border-radius:20px}` (colour layer) overrides the phone sheet rule `…0 0`]', async ({ browser }) => {
    const phone = await signedInPage(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
    try {
      await gotoApp(phone.page);
      await openModule(phone.page, 'Sales');
      await viewButton(phone.page, num(s.ids.inv1)).click();
      const dialog = details(phone.page);
      await expect(dialog).toBeVisible();
      await phone.page.waitForTimeout(600); // sheet-in animation
      const m = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { left: r.left, width: r.width, bottom: r.bottom, top: r.top, vw: window.innerWidth, vh: window.innerHeight, overflowY: cs.overflowY, sh: el.scrollHeight, ch: el.clientHeight, rTop: cs.borderTopLeftRadius, rBottom: cs.borderBottomLeftRadius }; });
      expect(m.left).toBe(0);
      expect(m.width).toBe(m.vw);
      expect(Math.abs(m.bottom - m.vh)).toBeLessThanOrEqual(1);
      expect(m.top).toBeGreaterThan(0);
      expect(parseFloat(m.rTop)).toBeGreaterThan(0);
      expect(m.rBottom).toBe('20px'); // documented in the title: the later `.dialog-content{border-radius:20px}` rule wins
      expect(['auto', 'scroll']).toContain(m.overflowY);
      expect(m.sh).toBeGreaterThan(m.ch);
      const box = (await dialog.boundingBox())!;
      await phone.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await phone.page.mouse.wheel(0, 600);
      await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expect(dialog.locator('.invoice-totals')).toBeInViewport();
    } finally { await phone.context.close(); }
  });
});
