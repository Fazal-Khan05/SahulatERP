import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/dates', () => import('../../src/modules/erp/dates'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
import { InventoryView } from '../../src/components/inventory-view';
import { postJournal, stock, summary } from '../../src/modules/erp/engine';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { documentView } from '../../src/modules/erp/documents';
import { stockMovements, stockValuation } from '../../src/modules/erp/reports';
import type { Actor, Workspace } from '../../src/modules/erp/types';
import { D, accountBalance, actor, expectInvariants, freshCompany, owner, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const MAIN = 'main-store';
const LHE = 'lahore';
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const invHtml = (w: Workspace, who: Actor = owner) => renderToStaticMarkup(createElement(InventoryView, { workspace: w, actor: who, busy: '', notice: '', command: async () => ({}), openStockTransfer: () => {} }));
const row = (html: string, sku: string) => html.slice(html.indexOf(`<td>${sku}</td>`)).split('</tr>')[0];

/** Precondition: LED-24 "LED Panel 24W" with 50 units @ 1,500 in Main store. */
function base(extra: Record<string, unknown> = {}): { w: Workspace; item: string } {
  const [w, item] = withItem(freshCompany(), { sku: 'LED-24', name: 'LED Panel 24W', reorderLevel: 0, ...extra }, { quantity: '50', cost: '1500' });
  return { w, item };
}
/** Adds a Lahore branch with a "Lahore" warehouse. */
function withLahore(w: Workspace) {
  const branch = run(w, 'save_branch', { name: 'Lahore' }, actor('Accountant'));
  return run(branch.workspace, 'save_warehouse', { name: 'Lahore', branchId: branch.recordId }).workspace;
}
const setQty = (w: Workspace, item: string, expected: string, target: string, extra: Record<string, unknown> = {}, who: Actor = owner) =>
  run(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: expected, targetQuantity: target, date: today(), reason: 'Physical count', ...extra }, who);
const bulk = (w: Workspace, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  run(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: 'Found in store', lines, ...extra });
const transfer = (w: Workspace, item: string, quantity: string, from = MAIN, to = LHE, who: Actor = owner, extra: Record<string, unknown> = {}) =>
  run(w, 'stock_transfer', { itemId: item, from, to, quantity, ...extra }, who);
function sell(w: Workspace, item: string, quantity: string, warehouseId = MAIN, kind = 'sales_invoice'): [Workspace, string] {
  let cust: string;
  [w, cust] = withParty(w);
  return withDocument(w, kind, cust, [{ itemId: item, quantity, price: '2400' }], { warehouseId });
}
const lastJournal = (w: Workspace) => w.journals.at(-1)!;

describe('06 inventory (INV)', () => {
  it('INV-001 Stock shows a row per product with quantity, average cost, value and badge', () => {
    const r = row(invHtml(base().w), 'LED-24');
    expect(r).toContain('<td>50 pcs</td><td>Rs 1,500</td><td>Rs 75,000</td>');
    expect(r).toContain('class="badge success">available<');
  });

  it('INV-002 single warehouse: heading "Stock", no warehouse column/filter/transfer, no "Main branch" text', () => {
    const html = invHtml(base().w);
    expect(html).toContain('<h2>Stock</h2>');
    expect(html).not.toContain('Transfer stock');
    expect(html).not.toContain('Warehouse filter');
    expect(html).not.toContain('Stock by warehouse');
    expect(html).not.toContain('Main branch');
  });

  it('INV-003 a second warehouse brings the warehouse filter, "Transfer stock" and the per-warehouse breakdown', () => {
    const html = invHtml(withLahore(base().w));
    expect(html).toContain('Stock across all warehouses');
    expect(html).toContain('Transfer stock');
    expect(html).toContain('aria-label="Warehouse filter"');
    expect(html).toContain('<h2>Stock by warehouse</h2>');
  });

  it('INV-004 movement history has the opening row: +50, value 75,000, type adjustment', () => {
    const { w, item } = base();
    expect(stockMovements(w, '2000-01-01', '2999-12-31', item)).toEqual([expect.objectContaining({ type: 'adjustment', quantity: '50.0000', value: '75000.0000', warehouse: 'Main store', reference: 'JV-00001' })]);
  });

  it('INV-005 set quantity 50 → 45: −5 at average cost; Dr 5300 / Cr 1200 7,500', () => {
    const { w, item } = base();
    const r = setQty(w, item, '50', '45');
    expect(r.message).toBe('LED Panel 24W in Main store updated from 50 to 45 pcs. Stock and ledger updated.');
    expect(r.workspace.stockMoves.at(-1)).toMatchObject({ quantity: '-5.0000', value: '-7500.0000', type: 'count_correction' });
    expect(lastJournal(r.workspace).lines).toEqual([{ account: '5300', debit: '7500.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '7500.0000' }]);
    expectInvariants(r.workspace);
  });

  it('INV-006 set quantity 45 → 60 at unit cost 1,600: +15 @ 1,600; average = (45×1500+15×1600)/60 = 1,525', () => {
    const { w, item } = base();
    const r = setQty(setQty(w, item, '50', '45').workspace, item, '45', '60', { cost: '1600' });
    expect(r.workspace.stockMoves.at(-1)).toMatchObject({ quantity: '15.0000', value: '24000.0000' });
    expect(stock(r.workspace, item)).toEqual({ quantity: '60.0000', value: '91500.0000', average: '1525.0000' });
  });

  it('INV-007 set quantity to the same number: "Enter a different quantity to save a stock correction."', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '50', date: today(), reason: 'x' }, 'Enter a different quantity to save a stock correction.');
  });

  it('INV-008 set quantity without a reason is refused [case-corrected: set_stock_quantity returns the min-length validation (form field is required); "Adjustment reason is required." is the stock_adjust message]', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: today(), reason: '   ' }, /"reason"[\s\S]*>=1 characters/);
    refused(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '-1', reason: '' }, 'Adjustment reason is required.');
  });

  it('INV-009 increase without a usable unit cost: "Enter a unit cost above zero for added stock."', () => {
    const [w, item] = withItem(freshCompany(), { cost: '0' });
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '0', targetQuantity: '5', date: today(), reason: 'Found' }, 'Enter a unit cost above zero for added stock.');
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '0', targetQuantity: '5', cost: '0', date: today(), reason: 'Found' }, 'Enter a unit cost above zero for added stock.');
  });

  it('INV-010 set quantity −1 refused "Amount cannot be negative." [browser part: min 0]', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '-1', date: today(), reason: 'x' }, 'Amount cannot be negative.');
  });

  it('INV-011 stale expected quantity: "Stock changed since you opened this item. Current quantity in Main store: N"', () => {
    const { w, item } = base();
    const [sold] = sell(w, item, '3');
    refused(sold, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: today(), reason: 'x' }, 'Stock changed since you opened this item. Current quantity in Main store: 47. Refresh and try again.');
  });

  it('INV-012 purpose opening_stock on an increase offsets to 3000', () => {
    const { w, item } = base();
    expect(lastJournal(setQty(w, item, '50', '55', { purpose: 'opening_stock' }).workspace).lines.map(l => l.account)).toEqual(['1200', '3000']);
  });

  it('INV-013 purpose count_correction on an increase offsets to 5300', () => {
    const { w, item } = base();
    expect(lastJournal(setQty(w, item, '50', '55', { purpose: 'count_correction' }).workspace).lines).toEqual([{ account: '1200', debit: '7500.0000', credit: '0.0000' }, { account: '5300', debit: '0.0000', credit: '7500.0000' }]);
  });

  it('INV-014 set quantity to 0.0001 accepted', () => {
    const { w, item } = base();
    expect(stock(setQty(w, item, '50', '0.0001').workspace, item)).toEqual({ quantity: '0.0001', value: '0.1500', average: '1500.0000' });
  });

  it('INV-015 set quantity 999,999,999 accepted [documented: the resulting value 1,499,999,923,500 exceeds one trillion; the below-one-trillion rule applies to inputs only]', () => {
    const { w, item } = base();
    const r = setQty(w, item, '50', '999999999');
    expect(stock(r.workspace, item).quantity).toBe('999999999.0000');
    expect(lastJournal(r.workspace).lines[0].debit).toBe('1499999923500.0000');
    expectInvariants(r.workspace);
  });

  it('INV-016 set quantity in a locked period: "Accounting period … is locked."', () => {
    const { w, item } = base();
    const month = today().slice(0, 7);
    const locked = run(w, 'set_period', { month, locked: true }, actor('Accountant')).workspace;
    refused(locked, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: today(), reason: 'x' }, `Accounting period ${month} is locked.`);
  });

  it('INV-017 future-dated correction [documented: accepted (no future-date guard)]', () => {
    const { w, item } = base();
    const r = setQty(w, item, '50', '45', { date: '2099-01-15' });
    expect(r.workspace.stockMoves.at(-1)!.date).toBe('2099-01-15');
  });

  it('INV-018 date 2026-02-30 is a validation error', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: '2026-02-30', reason: 'x' }, /"date"/);
  });

  it('INV-019 bulk increase for two products: two movements and one journal with the total', () => {
    let { w, item } = base(); let other: string;
    [w, other] = withItem(w, { sku: 'KET-18' });
    const before = w.journals.length;
    const r = bulk(w, [{ itemId: item, quantity: '10', cost: '1500' }, { itemId: other, quantity: '4', cost: '2750' }]);
    expect(r.message).toBe('Increased stock for 2 products. Inventory value and journal updated.');
    expect(r.workspace.stockMoves.slice(-2).map(m => [m.quantity, m.value])).toEqual([['10.0000', '15000.0000'], ['4.0000', '11000.0000']]);
    expect(r.workspace.journals.length).toBe(before + 1);
    expect(lastJournal(r.workspace).lines).toEqual([{ account: '1200', debit: '26000.0000', credit: '0.0000' }, { account: '5300', debit: '0.0000', credit: '26000.0000' }]);
  });

  it('INV-020 bulk increase with a duplicate product: "Each product can appear only once in a stock increase."', () => {
    const { w, item } = base();
    refused(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: 'x', lines: [{ itemId: item, quantity: '1', cost: '1' }, { itemId: item, quantity: '2', cost: '1' }] }, 'Each product can appear only once in a stock increase.');
  });

  it('INV-021 bulk increase line qty 0: "Amount must be greater than zero."', () => {
    const { w, item } = base();
    refused(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: 'x', lines: [{ itemId: item, quantity: '0', cost: '1' }] }, 'Amount must be greater than zero.');
  });

  it('INV-022 bulk increase whose value rounds to 0 (0.0001 × 0.0001): "Each added stock line must have a positive value."', () => {
    const { w, item } = base();
    refused(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: 'x', lines: [{ itemId: item, quantity: '0.0001', cost: '0.0001' }] }, 'Each added stock line must have a positive value.');
  });

  it('INV-023 bulk increase with 501 lines: validation max 500', () => {
    const { w } = base();
    refused(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: 'x', lines: Array.from({ length: 501 }, (_, i) => ({ itemId: `x${i}`, quantity: '1', cost: '1' })) }, /<=500 items/);
  });

  it('INV-024 bulk increase with an empty reason: validation error', () => {
    const { w, item } = base();
    refused(w, 'bulk_stock_increase', { warehouseId: MAIN, date: today(), purpose: 'count_correction', reason: '  ', lines: [{ itemId: item, quantity: '1', cost: '1' }] }, /"reason"/);
  });

  it('INV-025 transfer 10 units Main → Lahore at the same value with no P&L effect', () => {
    let { w, item } = base();
    w = withLahore(w);
    const r = transfer(w, item, '10');
    expect(r.message).toBe('Moved 10 LED Panel 24W from Main store to Lahore.');
    expect([stock(r.workspace, item, MAIN).value, stock(r.workspace, item, LHE).value]).toEqual(['60000.0000', '15000.0000']);
    expect(r.workspace.journals).toEqual(w.journals);
    expectInvariants(r.workspace);
  });

  it('INV-026 transfer to the same warehouse: "Choose two different warehouses."', () => {
    const { w, item } = base();
    refused(w, 'stock_transfer', { itemId: item, from: MAIN, to: MAIN, quantity: '1' }, 'Choose two different warehouses.');
  });

  it('INV-027 transfer 60 with 50 available: "Insufficient stock for LED Panel 24W in Main store. Requested: 60, available: 50."', () => {
    const { w, item } = base();
    refused(withLahore(w), 'stock_transfer', { itemId: item, from: MAIN, to: LHE, quantity: '60' }, 'Insufficient stock for LED Panel 24W in Main store. Requested: 60, available: 50.');
  });

  it('INV-028 transfer 0 refused', () => {
    const { w, item } = base();
    refused(withLahore(w), 'stock_transfer', { itemId: item, from: MAIN, to: LHE, quantity: '0' }, 'Amount must be greater than zero.');
  });

  it('INV-029 the transfer dialog closes on success (scoped auto-close) [browser part]', () => {
    expect(source('src/components/workbench.tsx')).toContain("if(type==='stock_transfer')setStockTransferOpen(false)");
  });

  it('INV-030 transfer in a locked period is refused', () => {
    const { w, item } = base();
    const locked = run(withLahore(w), 'set_period', { month: '2026-03', locked: true }, actor('Accountant')).workspace;
    refused(locked, 'stock_transfer', { itemId: item, from: MAIN, to: LHE, quantity: '1', date: '2026-03-10' }, 'Accounting period 2026-03 is locked.');
  });

  it('INV-031 Warehouse Manager of branch A transferring from branch B: "This warehouse is outside your permitted branches."', () => {
    const { w, item } = base();
    refused(withLahore(w), 'stock_transfer', { itemId: item, from: MAIN, to: LHE, quantity: '1' }, 'This warehouse is outside your permitted branches.', actor('Warehouse Manager', { branchIds: [w.branches.find(b => b.name === 'Lahore')?.id ?? 'lahore'] }));
  });

  it('INV-032 Salesperson and Inventory [documented: Inventory is not in the Salesperson sidebar; the stock data is still sent (for selling) and the view has no edit/transfer buttons]', () => {
    const { w } = base();
    const wb = source('src/components/workbench.tsx');
    expect(wb).toContain("'Salesperson':['dashboard','sales','collections','commissions']");
    const sp = actor('Salesperson', { employeeId: 'e-1' });
    expect(scopeWorkspace(w, sp).stockMoves).toHaveLength(1);
    const html = invHtml(withLahore(w), sp);
    expect(html).not.toContain('Transfer stock');
    expect(html).not.toContain('aria-label="Edit ');
  });

  it('INV-033 average cost is unchanged in both warehouses after a transfer', () => {
    const { w, item } = base();
    const r = transfer(withLahore(w), item, '10');
    expect([stock(r.workspace, item, MAIN).average, stock(r.workspace, item, LHE).average]).toEqual(['1500.0000', '1500.0000']);
  });

  it('INV-034 sale of 10 at average 1,500: COGS 15,000, stock 40 worth 60,000', () => {
    const { w, item } = base();
    const [sold] = sell(w, item, '10');
    expect(accountBalance(sold, '5000')).toBe('15000.0000');
    expect(stock(sold, item)).toEqual({ quantity: '40.0000', value: '60000.0000', average: '1500.0000' });
  });

  it('INV-035 purchase receipt 20 @ 1,800 moves the average to (40×1500+20×1800)/60 = 1,600', () => {
    let { w, item } = base(); let supp: string;
    [w] = sell(w, item, '10');
    [w, supp] = withParty(w, 'supplier');
    [w] = withDocument(w, 'goods_receipt', supp, [{ itemId: item, quantity: '20', price: '1800' }]);
    expect(stock(w, item)).toEqual({ quantity: '60.0000', value: '96000.0000', average: '1600.0000' });
  });

  it('INV-036 a sale after that uses the 1,600 average', () => {
    let { w, item } = base(); let supp: string, inv: string;
    [w] = sell(w, item, '10');
    [w, supp] = withParty(w, 'supplier');
    [w] = withDocument(w, 'goods_receipt', supp, [{ itemId: item, quantity: '20', price: '1800' }]);
    [w, inv] = sell(w, item, '5');
    expect(w.documents.find(d => d.id === inv)!.lines[0].cost).toBe('1600.0000');
    expect(accountBalance(w, '5000')).toBe('23000.0000');
    expectInvariants(w);
  });

  it('INV-037 returning 1 unit from an invoice restores stock at the invoice line\'s cost', () => {
    let { w, item } = base(); let inv: string;
    [w, inv] = sell(w, item, '10');
    const line = w.documents.find(d => d.id === inv)!.lines[0];
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: line.id, quantity: '1' }] }).workspace;
    expect(w.stockMoves.at(-1)).toMatchObject({ quantity: '1.0000', value: '1500.0000', type: 'return' });
    expect(stock(w, item)).toEqual({ quantity: '41.0000', value: '61500.0000', average: '1500.0000' });
    expectInvariants(w);
  });

  it('INV-038 stock never goes negative: direct invoice, delivery, transfer and corrections are all guarded', () => {
    let { w, item } = base(); let cust: string, inv: string, dn: string;
    w = withLahore(w);
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '51', price: '1' }], {}, false);
    [w, dn] = withDocument(w, 'delivery', cust, [{ itemId: item, quantity: '51', price: '1' }], {}, false);
    refused(w, 'submit_document', { id: inv }, /Insufficient stock/);
    refused(w, 'submit_document', { id: dn }, /Insufficient stock/);
    refused(w, 'stock_transfer', { itemId: item, from: MAIN, to: LHE, quantity: '50.0001' }, /Insufficient stock/);
    refused(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '-51', reason: 'loss' }, /Insufficient stock/);
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '-1', date: today(), reason: 'x' }, 'Amount cannot be negative.');
    expectInvariants(w);
  });

  it('INV-039 rounding: 3 units @ 10.0001, sold one at a time, never drifts and ends at value 0', () => {
    let [w, item] = withItem(freshCompany(), {}, { quantity: '3', cost: '10.0001' });
    for (let i = 0; i < 3; i++) {
      [w] = sell(w, item, '1');
      const level = stock(w, item);
      expect(D(level.value).minus(D(level.quantity).mul('10.0001')).abs().lte('0.0001')).toBe(true);
    }
    expect(stock(w, item)).toEqual({ quantity: '0.0000', value: '0.0000', average: '0.0000' });
    expectInvariants(w);
  });

  it('INV-040 selling exactly all stock leaves quantity 0 and value exactly 0.0000', () => {
    let { w, item } = base();
    w = setQty(w, item, '50', '7', { reason: 'odd count' }).workspace;
    [w] = sell(w, item, '7');
    expect(stock(w, item)).toEqual({ quantity: '0.0000', value: '0.0000', average: '0.0000' });
  });

  it.todo('INV-041 [browser] stock level filter Available / Low / Out shows the right sets');
  it.todo('INV-042 [browser] category filter narrows the Stock list');
  it.todo('INV-043 [browser] Stock search by SKU');

  it('INV-044 "out of stock" badge (danger) at quantity 0', () => {
    const [w] = withItem(base().w, { sku: 'EMPTY-1' });
    expect(row(invHtml(w), 'EMPTY-1')).toContain('class="badge danger">out of stock<');
  });

  it('INV-045 "low stock" when quantity ≤ reorder level and > 0; "available" above it', () => {
    let [w] = withItem(freshCompany(), { sku: 'AT-10', reorderLevel: 10 }, { quantity: '10', cost: '5' });
    [w] = withItem(w, { sku: 'AT-11', reorderLevel: 10 }, { quantity: '11', cost: '5' });
    const html = invHtml(w);
    expect(row(html, 'AT-10')).toContain('class="badge warning">low stock<');
    expect(row(html, 'AT-11')).toContain('class="badge success">available<');
  });

  it('INV-046 Overview attention queue for low stock [case-corrected: the Overview attention list has no low-stock entry; low stock shows only as Inventory badges/filter]', () => {
    const wb = source('src/components/workbench.tsx');
    const attention = wb.slice(wb.indexOf('function attentionItems'), wb.indexOf('function WorkspaceSwitcher'));
    expect(attention).not.toMatch(/reorder|low stock/i);
  });

  it('INV-047 a warehouse is added under a branch with a unique slug id', () => {
    const r = run(base().w, 'save_warehouse', { name: 'Port Godown', branchId: 'main' });
    expect(r.message).toBe('Warehouse Port Godown saved.');
    expect(r.workspace.warehouses.at(-1)).toEqual({ id: 'port-godown', name: 'Port Godown', branchId: 'main' });
  });

  it('INV-048 duplicate warehouse name: "Warehouse X already exists."', () => {
    refused(base().w, 'save_warehouse', { name: 'main STORE', branchId: 'main' }, 'Warehouse main STORE already exists.');
  });

  it('INV-049 empty warehouse name refused', () => {
    refused(base().w, 'save_warehouse', { name: ' ', branchId: 'main' }, />=2 characters/);
  });

  it('INV-050 a branch is added; a duplicate is refused "Branch X already exists."', () => {
    const w = run(base().w, 'save_branch', { name: 'Lahore' }, actor('Accountant')).workspace;
    expect(w.branches.map(b => b.name)).toEqual(['Main branch', 'Lahore']);
    refused(w, 'save_branch', { name: 'lahore' }, 'Branch lahore already exists.', actor('Accountant'));
  });

  it.todo('INV-051 [browser] branch picker appears in the header only with ≥2 branches');
  it.todo('INV-052 [browser] branch picker filters documents and stock');

  it('INV-053 a member limited to branch A receives only branch A warehouses and stock [browser part: picker locked]', () => {
    let { w, item } = base();
    w = withLahore(w);
    w = transfer(w, item, '10').workspace;
    const lahoreBranch = w.branches.find(b => b.name === 'Lahore')!.id;
    const scoped = scopeWorkspace(w, actor('Warehouse Manager', { branchIds: [lahoreBranch] }));
    expect(scoped.warehouses.map(x => x.id)).toEqual([LHE]);
    expect(new Set(scoped.stockMoves.map(m => m.warehouseId))).toEqual(new Set([LHE]));
    expect(scoped.branches.map(b => b.id)).toEqual([lahoreBranch]);
  });

  it('INV-054 archiving a warehouse [documented: there is no warehouse archive; set_archived accepts only party/item]', () => {
    refused(base().w, 'set_archived', { kind: 'warehouse', id: MAIN, archived: true }, /"kind"/);
  });

  it('INV-055 documents default to the first warehouse [browser part]', () => {
    expect(source('src/components/document-editor.tsx')).toContain("useState(existing?.warehouseId ?? warehouses[0]?.id ?? '')");
  });

  it.todo('INV-056 [browser] document warehouse select is hidden with a single warehouse');

  it('INV-057 stock valuation report equals the Stock tab total to the paisa', () => {
    let { w, item } = base();
    w = withLahore(w);
    w = transfer(w, item, '7').workspace;
    [w] = sell(w, item, '3');
    const tabTotal = sum(w.items.map(i => stock(w, i.id).value));
    expect(stockValuation(w).total).toBe(tabTotal.toFixed(4));
  });

  it('INV-058 inventory control 1200 equals valuation (reconciled)', () => {
    let { w, item } = base();
    [w] = sell(w, item, '3');
    expect(accountBalance(w, '1200')).toBe(stockValuation(w).total);
    expectInvariants(w);
  });

  it('INV-059 movement types adjustment, sale, purchase, transfer and return are labelled and linked to their source', () => {
    let { w, item } = base(); let supp: string, inv: string, grn: string;
    w = withLahore(w);
    [w, supp] = withParty(w, 'supplier');
    [w, grn] = withDocument(w, 'goods_receipt', supp, [{ itemId: item, quantity: '5', price: '1500' }]);
    w = transfer(w, item, '2').workspace;
    [w, inv] = sell(w, item, '4');
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '1' }] }).workspace;
    const rows = stockMovements(w, '2000-01-01', '2999-12-31', item);
    expect(rows.map(r => r.type)).toEqual(['adjustment', 'purchase', 'transfer out', 'transfer in', 'sale', 'return']);
    const number = (id: string) => w.documents.find(d => d.id === id)!.number;
    expect(rows.find(r => r.type === 'purchase')!.reference).toBe(number(grn));
    expect(rows.find(r => r.type === 'sale')!.reference).toBe(number(inv));
  });

  it('INV-060 movement history order [case-corrected: the report is chronological; Item details shows the newest 20 movements first with no running quantity]', () => {
    let { w, item } = base();
    w = setQty(w, item, '50', '40', { date: '2026-01-05' }).workspace;
    expect(stockMovements(w, '2000-01-01', '2999-12-31', item).map(r => r.date)).toEqual(['2026-01-05', today()]);
    expect(source('src/components/item-details.tsx')).toContain('workspace.stockMoves.filter(move => move.itemId === item.id).slice().reverse().slice(0, 20)');
  });

  it.todo('INV-061 [browser] item details on phone: sections stack, history scrolls');
  it.todo('INV-062 [browser] set-quantity dialog closes on success');
  it.todo('INV-063 [browser] set-quantity dialog shows the current quantity and value');

  it('INV-064 reason of 2,000 characters accepted; 2,001 refused', () => {
    const { w, item } = base();
    expect(lastJournal(setQty(w, item, '50', '49', { reason: 'R'.repeat(2000) }).workspace).memo).toContain('R'.repeat(2000));
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '49', date: today(), reason: 'R'.repeat(2001) }, /<=2000 characters/);
  });

  it('INV-065 a unit cost with 4 decimals is used exactly', () => {
    const { w, item } = base();
    expect(setQty(w, item, '50', '51', { cost: '1600.1234' }).workspace.stockMoves.at(-1)).toMatchObject({ quantity: '1.0000', value: '1600.1234' });
  });

  it('INV-066 unit cost 0.00001 rounds to 0 at input (4 dp): "Enter a unit cost above zero for added stock." for any quantity', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '51', cost: '0.00001', date: today(), reason: 'x' }, 'Enter a unit cost above zero for added stock.');
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '65', cost: '0.00001', date: today(), reason: 'x' }, 'Enter a unit cost above zero for added stock.');
  });

  it('INV-067 correction journal memo contains the reason', () => {
    const { w, item } = base();
    expect(lastJournal(setQty(w, item, '50', '48', { reason: 'Two broken in transit' }).workspace).memo).toBe('Stock correction · LED-24 · Main store · Two broken in transit');
  });

  it('INV-068 journal source id = movement source id; re-posting the same source: "This source has already been posted."', () => {
    const { w, item } = base();
    const r = setQty(w, item, '50', '48');
    const moveSource = r.workspace.stockMoves.at(-1)!.sourceId;
    expect(lastJournal(r.workspace).sourceId).toBe(moveSource);
    expect(r.recordId).toBe(moveSource);
    const copy = structuredClone(r.workspace);
    expect(() => postJournal(copy, moveSource, 'again', [{ account: '1200', debit: '1', credit: '0' }, { account: '5300', debit: '0', credit: '1' }])).toThrow('This source has already been posted.');
  });

  it('INV-069 an idempotent retry of set_stock_quantity creates a single movement [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    const { w, item } = base();
    const first = setQty(w, item, '50', '45', {}, owner);
    const payload = { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: today(), reason: 'Physical count' };
    const once = run(w, 'set_stock_quantity', payload, owner, 'qa-inv-069');
    const retry = run(once.workspace, 'set_stock_quantity', payload, owner, 'qa-inv-069');
    expect([retry.recordId, retry.message]).toEqual([once.recordId, once.message]);
    expect(retry.workspace.stockMoves.length).toBe(first.workspace.stockMoves.length);
  });

  it('INV-070 with stock in two warehouses, selling from Lahore leaves Main unchanged', () => {
    let { w, item } = base();
    w = transfer(withLahore(w), item, '10').workspace;
    [w] = sell(w, item, '4', LHE);
    expect([stock(w, item, MAIN).quantity, stock(w, item, LHE).quantity]).toEqual(['40.0000', '6.0000']);
  });

  it('INV-071 delivery from a warehouse with none of the item names that warehouse in the message', () => {
    let { w, item } = base(); let cust: string, dn: string;
    w = withLahore(w);
    [w, cust] = withParty(w);
    [w, dn] = withDocument(w, 'delivery', cust, [{ itemId: item, quantity: '1', price: '1' }], { warehouseId: LHE }, false);
    refused(w, 'submit_document', { id: dn }, 'Insufficient stock for LED Panel 24W in Lahore. Requested: 1, available: 0.');
  });

  it('INV-072 Stock tab totals row [case-corrected: the Stock tab has no totals row; the total is in Reports → Stock valuation]', () => {
    const html = invHtml(base().w);
    expect(html).not.toMatch(/<tfoot|>Total</);
    expect(stockValuation(base().w).total).toBe('75000.0000');
  });

  it('INV-073 stock valuation report rows match the Stock tab per product and warehouse [browser part: CSV download]', () => {
    let { w, item } = base();
    w = transfer(withLahore(w), item, '10').workspace;
    expect(stockValuation(w).rows.map(r => [r.warehouse, r.quantity, r.average, r.value])).toEqual([['Main store', '40.0000', '1500.0000', '60000.0000'], ['Lahore', '10.0000', '1500.0000', '15000.0000']]);
    expect(source('src/components/reports-view.tsx')).toContain('download = `${key}-${asOf}.csv`');
  });

  it('INV-074 archived product with stock still shows in the Stock tab [case-corrected: shown, but without an "archived" mark]', () => {
    let { w, item } = base();
    w = run(w, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    const r = row(invHtml(w), 'LED-24');
    expect(r).toContain('<td>50 pcs</td>');
    expect(r).not.toMatch(/archived/i);
  });

  it('INV-075 stock in only one of two warehouses: the breakdown shows 0 for the other', () => {
    const html = invHtml(withLahore(base().w));
    const breakdown = html.slice(html.indexOf('<h2>Stock by warehouse</h2>'));
    expect(breakdown).toContain('<td>LED Panel 24W</td><td>Lahore</td><td>0 pcs</td><td>Rs 0</td><td>Rs 0</td>');
  });

  it('INV-076 transfer warehouse selects and archived warehouses [documented: warehouses cannot be archived, so there is nothing to exclude]', () => {
    refused(base().w, 'set_archived', { kind: 'warehouse', id: MAIN, archived: true }, /"kind"/);
  });

  it('INV-077 transfer of multiple lines [documented: a transfer moves one product; each is guarded on its own and an over-quantity transfer changes nothing]', () => {
    let { w, item } = base(); let other: string;
    [w, other] = withItem(withLahore(w), { sku: 'KET-18' }, { quantity: '3', cost: '100' });
    w = transfer(w, item, '5').workspace;
    refused(w, 'stock_transfer', { itemId: other, from: MAIN, to: LHE, quantity: '4' }, /Insufficient stock/);
    expect(stock(w, other, MAIN).quantity).toBe('3.0000');
    expect(source('src/components/stock-transfer-dialog.tsx')).toContain("command('stock_transfer', { itemId: item.id, from: from.id, to: to.id, quantity, date }");
  });

  it('INV-078 transfer with an unknown item: "Product not found."', () => {
    refused(withLahore(base().w), 'stock_transfer', { itemId: 'nope', from: MAIN, to: LHE, quantity: '1' }, 'Product not found.');
  });

  it('INV-079 transfer with an unknown warehouse: "Warehouse not found."', () => {
    const { w, item } = base();
    refused(w, 'stock_transfer', { itemId: item, from: MAIN, to: 'nowhere', quantity: '1' }, 'Warehouse not found.');
  });

  it('INV-080 stock_adjust with a non-zero quantity is posted', () => {
    const { w, item } = base();
    const r = run(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '-2', reason: 'Damaged' });
    expect(r.workspace.stockMoves.at(-1)).toMatchObject({ quantity: '-2.0000', value: '-3000.0000', type: 'adjustment' });
    expect(lastJournal(r.workspace)).toMatchObject({ memo: 'Damaged', lines: [{ account: '5300', debit: '3000.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '3000.0000' }] });
    expectInvariants(r.workspace);
  });

  it('INV-081 stock_adjust 0: "Enter a non-zero adjustment."', () => {
    const { w, item } = base();
    refused(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '0', reason: 'x' }, 'Enter a non-zero adjustment.');
  });

  it('INV-082 count correction with no stock history uses the product standard cost; with cost 0 it needs a unit cost', () => {
    let [w, item] = withItem(freshCompany(), { cost: '75' });
    w = run(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '0', targetQuantity: '4', date: today(), reason: 'Found' }).workspace;
    expect(stock(w, item)).toEqual({ quantity: '4.0000', value: '300.0000', average: '75.0000' });
    const [z, zero] = withItem(freshCompany(), { cost: '0' });
    refused(z, 'set_stock_quantity', { itemId: zero, warehouseId: MAIN, expectedQuantity: '0', targetQuantity: '4', date: today(), reason: 'Found' }, 'Enter a unit cost above zero for added stock.');
  });

  it('INV-083 valuation after opening, purchase, sale, return, correction and transfer equals the sum of movement values', () => {
    let { w, item } = base(); let supp: string, inv: string;
    w = withLahore(w);
    [w, supp] = withParty(w, 'supplier');
    [w] = withDocument(w, 'goods_receipt', supp, [{ itemId: item, quantity: '20', price: '1800' }]);
    [w, inv] = sell(w, item, '7');
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '2' }] }).workspace;
    w = setQty(w, item, stock(w, item, MAIN).quantity, '60').workspace;
    w = transfer(w, item, '9').workspace;
    expect(stockValuation(w).total).toBe(sum(w.stockMoves.map(m => m.value)).toFixed(4));
    expectInvariants(w);
  });

  it('INV-084 stock movements report matches the movement history', () => {
    let { w, item } = base();
    w = transfer(withLahore(w), item, '5').workspace;
    const report = stockMovements(w, '2000-01-01', '2999-12-31');
    expect(report.map(r => [r.quantity, r.value])).toEqual(w.stockMoves.map(m => [m.quantity, m.value]));
  });

  it('INV-085 Overview "Inventory value" equals valuation', () => {
    let { w, item } = base();
    [w] = sell(w, item, '5');
    expect(summary(w).inventory).toBe(stockValuation(w).total);
  });

  it('INV-086 Stock tab for 2,000 products × 3 warehouses renders in under 2 s (server-side render alone measured 2.0–3.0 s) [browser part: real browser] [defect]', () => {
    let w = withLahore(freshCompany());
    w = run(w, 'save_warehouse', { name: 'Port', branchId: 'main' }).workspace;
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, sku: `P-${i}`, name: `Product ${i}`, category: 'General', hsCode: '', unit: 'pcs', price: '1', cost: '1', weight: '1', volume: '1', reorderLevel: 0 }));
    const stockMoves = items.flatMap(it => w.warehouses.map(x => ({ id: `${it.id}-${x.id}`, itemId: it.id, warehouseId: x.id, date: today(), quantity: '1.0000', value: '1.0000', sourceId: 'synthetic', type: 'adjustment' })));
    const big: Workspace = { ...w, items, stockMoves };
    const start = performance.now();
    const html = invHtml(big);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(html).toContain('P-1999');
  });

  it.todo('INV-087 [browser] 50,000 movements for one item: history stays responsive (Item details shows the newest 20)');

  it('INV-088 a renamed warehouse is reflected in history and on documents', () => {
    let { w, item } = base();
    w = withLahore(w);
    [w] = sell(w, item, '1');
    w = run(w, 'save_warehouse', { id: MAIN, name: 'Karachi Central', branchId: 'main' }).workspace;
    expect(stockMovements(w, '2000-01-01', '2999-12-31', item).every(r => r.warehouse === 'Karachi Central')).toBe(true);
    expect(documentView(w, w.documents[0]).meta).toContainEqual({ label: 'Warehouse', value: 'Karachi Central' });
  });

  it('INV-089 a renamed branch is saved under the same id [browser part: picker label]', () => {
    const w = run(base().w, 'save_branch', { id: 'main', name: 'Karachi HQ' }, actor('Accountant')).workspace;
    expect(w.branches).toEqual([{ id: 'main', name: 'Karachi HQ' }]);
    expect(w.warehouses[0].branchId).toBe('main');
  });

  it('INV-090 Auditor sees stock read-only: no Edit or Transfer buttons, and stock commands are refused', () => {
    const { w, item } = base();
    const html = invHtml(withLahore(w), actor('Auditor'));
    expect(html).toContain('aria-label="View LED Panel 24W"');
    expect(html).not.toContain('aria-label="Edit LED Panel 24W"');
    expect(html).not.toContain('Transfer stock');
    refused(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '1', reason: 'x' }, 'Your role does not permit this action.', actor('Auditor'));
  });

  it('INV-091 set_stock_quantity as Salesperson via API is refused', () => {
    const { w, item } = base();
    refused(w, 'set_stock_quantity', { itemId: item, warehouseId: MAIN, expectedQuantity: '50', targetQuantity: '45', date: today(), reason: 'x' }, 'Your role does not permit this action.', actor('Salesperson'));
  });

  it('INV-092 with Inventory hidden, stock commands are refused but a sale still moves stock [browser part: view gone]', () => {
    let { w, item } = base();
    w = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'inventory' && m !== 'imports') }).workspace;
    refused(w, 'stock_adjust', { itemId: item, warehouseId: MAIN, quantity: '1', reason: 'x' }, 'Inventory is turned off for this company. Turn it on in Settings → Features.');
    [w] = sell(w, item, '5');
    expect(stock(w, item).quantity).toBe('45.0000');
    expectInvariants(w);
  });

  it('INV-093 re-enabling Inventory returns the view with all data', () => {
    const { w } = base();
    const hidden = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'inventory' && m !== 'imports') }).workspace;
    const back = run(hidden, 'set_modules', { enabled: w.modules }).workspace;
    expect([back.items, back.stockMoves, back.warehouses]).toEqual([w.items, w.stockMoves, w.warehouses]);
  });

  it('INV-094 warehouse name with emoji saved', () => {
    const r = run(base().w, 'save_warehouse', { name: 'Godown 📦 East', branchId: 'main' });
    expect(r.workspace.warehouses.at(-1)).toEqual({ id: 'godown-east', name: 'Godown 📦 East', branchId: 'main' });
  });

  it.todo('INV-095 [browser] 50 warehouses: selects remain usable');

  it('INV-096 transfers post immediately (no draft); reversing needs an opposite transfer', () => {
    let { w, item } = base();
    w = transfer(withLahore(w), item, '10').workspace;
    w = transfer(w, item, '10', LHE, MAIN).workspace;
    expect([stock(w, item, MAIN), stock(w, item, LHE).quantity]).toEqual([{ quantity: '50.0000', value: '75000.0000', average: '1500.0000' }, '0.0000']);
    expect(w.documents).toEqual([]);
  });

  it('INV-097 a transfer posts no journal (no accounting effect)', () => {
    const { w, item } = base();
    const r = transfer(withLahore(w), item, '10');
    expect(r.workspace.journals.length).toBe(w.journals.length);
    expectInvariants(r.workspace);
  });

  it('INV-098 quantity shown with unit ("50 pcs"); blank unit shows the number only', () => {
    let [w] = withItem(base().w, { sku: 'NOUNIT', unit: '' }, { quantity: '50', cost: '1' });
    const html = invHtml(w);
    expect(row(html, 'LED-24')).toContain('<td>50 pcs</td>');
    expect(row(html, 'NOUNIT')).toContain('<td>50 </td>');
  });

  it('INV-099 average cost formatted "Rs 1,500"', () => {
    expect(row(invHtml(base().w), 'LED-24')).toContain('<td>Rs 1,500</td>');
  });

  it('INV-100 end to end: opening → purchase → transfer → sale → return → correction; reconciliation reconciled', () => {
    let { w, item } = base(); let supp: string, inv: string;
    w = withLahore(w);
    [w, supp] = withParty(w, 'supplier');
    [w] = withDocument(w, 'goods_receipt', supp, [{ itemId: item, quantity: '20', price: '1800' }]);
    w = transfer(w, item, '15').workspace;
    [w, inv] = sell(w, item, '12', LHE);
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '2' }] }).workspace;
    w = setQty(w, item, stock(w, item, MAIN).quantity, '50').workspace;
    expect(stock(w, item, LHE).quantity).toBe('5.0000');
    expect(stock(w, item, MAIN).quantity).toBe('50.0000');
    expect(accountBalance(w, '1200')).toBe(stockValuation(w).total);
    expectInvariants(w);
  });
});
