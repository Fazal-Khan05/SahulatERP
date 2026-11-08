import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Papa from 'papaparse';
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/dates', () => import('../../src/modules/erp/dates'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
import { InventoryView } from '../../src/components/inventory-view';
import { stock } from '../../src/modules/erp/engine';
import { csvFields, items as itemSpec, mapHeader, toCsv } from '../../src/modules/erp/master-data';
import { formatMoney } from '../../src/modules/erp/money';
import { moduleRecordCounts } from '../../src/modules/erp/modules';
import { documentView } from '../../src/modules/erp/documents';
import { stockMovements, stockValuation } from '../../src/modules/erp/reports';
import type { Actor, Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, buildDemoWorkspace, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withDocument, withItem, withParty } from './helpers';

const product = (extra: Record<string, unknown> = {}) => ({ sku: 'LED-24', name: 'LED Panel 24W', category: 'Lighting', hsCode: '9405.1100', unit: 'pcs', price: '2400', cost: '1450', weight: '0.65', volume: '0.008', reorderLevel: 0, ...extra });
const opening = (w: Workspace, itemId: string, quantity: string, cost: string, extra: Record<string, unknown> = {}, who: Actor = owner) =>
  run(w, 'bulk_stock_increase', { warehouseId: firstWarehouse(w), date: today(), purpose: 'opening_stock', reason: 'Opening stock for LED-24', lines: [{ itemId, quantity, cost }], ...extra }, who);
const errorOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ''; };
const invHtml = (w: Workspace, who: Actor = owner) => renderToStaticMarkup(createElement(InventoryView, { workspace: w, actor: who, busy: '', notice: '', command: async () => ({}), openStockTransfer: () => {} }));
const badgeFor = (html: string, sku: string) => html.slice(html.indexOf(`<td>${sku}</td>`)).match(/class="badge (\w+)">([^<]+)</)!.slice(1);
const search = (w: Workspace, query: string) => { const needle = query.trim().toLocaleLowerCase(); return w.items.filter(i => itemSpec.searchText(i, w).toLocaleLowerCase().includes(needle)); };
const parse = (text: string) => Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() });
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const fields = csvFields(itemSpec as never);
const importRows = (n: number, prefix = 'IMP') => Array.from({ length: n }, (_, i) => ({ sku: `${prefix}-${i + 1}`, name: `Imported product ${i + 1}`, price: String(100 + i), cost: '50', category: 'General' }));

describe('04 products (PRD)', () => {
  it('PRD-001 new product with SKU, name and price saved: "{name} saved." and listed', () => {
    const r = run(freshCompany(), 'save_item', product());
    expect(r.message).toBe('LED Panel 24W saved.');
    expect(itemSpec.records(r.workspace).map(i => i.sku)).toEqual(['LED-24']);
  });

  it('PRD-002 empty SKU refused; spec marks SKU required [case-corrected: API error is the min-length validation (route shows "Check the highlighted information."); "SKU is required" is the CSV import message]', () => {
    refused(freshCompany(), 'save_item', product({ sku: '' }), /"sku"[\s\S]*>=1 characters/);
    expect(itemSpec.fields.find(f => f.key === 'sku')!.required).toBe(true);
  });

  it('PRD-003 empty name refused (min 2)', () => {
    refused(freshCompany(), 'save_item', product({ name: '' }), /"name"[\s\S]*>=2 characters/);
  });

  it('PRD-004 one-character name refused', () => {
    refused(freshCompany(), 'save_item', product({ name: 'L' }), />=2 characters/);
  });

  it('PRD-005 duplicate SKU in different case: "SKU LED-24 already exists."', () => {
    const w = run(freshCompany(), 'save_item', product({ sku: 'led-24' })).workspace;
    refused(w, 'save_item', product({ sku: 'LED-24', name: 'Other' }), 'SKU LED-24 already exists.');
  });

  it('PRD-006 SKU with surrounding spaces is trimmed before the uniqueness check and on save', () => {
    const w = run(freshCompany(), 'save_item', product({ sku: '  LED-24  ' })).workspace;
    expect(w.items[0].sku).toBe('LED-24');
    refused(w, 'save_item', product({ sku: ' led-24 ', name: 'Other' }), 'SKU led-24 already exists.');
  });

  it('PRD-007 SKU of 50 characters accepted; 51 refused', () => {
    expect(run(freshCompany(), 'save_item', product({ sku: 'S'.repeat(50) })).workspace.items[0].sku).toHaveLength(50);
    refused(freshCompany(), 'save_item', product({ sku: 'S'.repeat(51) }), /<=50 characters/);
  });

  it('PRD-008 SKU with slash, hash and Urdu accepted and shown on documents', () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    [w, item] = withItem(w, { sku: 'LED/24#بتی' }, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }]);
    expect(w.items[0].sku).toBe('LED/24#بتی');
    expect(documentView(w, w.documents.find(d => d.id === inv)!).lines[0].detail).toBe('LED/24#بتی');
  });

  it('PRD-009 price left empty is blocked: spec required and API refuses a missing price', () => {
    expect(itemSpec.fields.find(f => f.key === 'price')!.required).toBe(true);
    const { price: _price, ...noPrice } = product();
    refused(freshCompany(), 'save_item', noPrice, /"price"/);
  });

  it('PRD-010 price 0 accepted (free item)', () => {
    expect(run(freshCompany(), 'save_item', product({ price: '0' })).workspace.items[0].price).toBe('0');
  });

  it('PRD-011 price -5: "Amount cannot be negative." [browser part: min=0]', () => {
    refused(freshCompany(), 'save_item', product({ price: '-5' }), 'Amount cannot be negative.');
  });

  it('PRD-012 price 0.0001 accepted and shows as Rs 0 in the list', () => {
    const w = run(freshCompany(), 'save_item', product({ price: '0.0001' })).workspace;
    expect(w.items[0].price).toBe('0.0001');
    expect(formatMoney(w.items[0].price)).toBe('Rs 0');
  });

  it('PRD-013 price 999999999999 accepted; 1000000000000 refused "Enter a valid number below one trillion."', () => {
    expect(run(freshCompany(), 'save_item', product({ price: '999999999999' })).workspace.items[0].price).toBe('999999999999');
    refused(freshCompany(), 'save_item', product({ price: '1000000000000' }), 'Enter a valid number below one trillion.');
  });

  it('PRD-014 price "abc" via API gives a validation error, not a raw library error', () => {
    const message = errorOf(() => run(freshCompany(), 'save_item', product({ price: 'abc' })));
    expect(message).not.toBe('');
    expect(message).not.toContain('DecimalError');
    expect(message).toMatch(/valid number/);
  });

  it('PRD-015 price "1e3" [documented: browser number input sends 1000; the API accepts "1e3" and stores it as typed, valued as 1000]', () => {
    const w = run(freshCompany(), 'save_item', product({ price: '1e3' })).workspace;
    expect(w.items[0].price).toBe('1e3');
    expect(formatMoney(w.items[0].price)).toBe('Rs 1,000');
  });

  it('PRD-016 price with 6 decimals is stored at 4 dp, rounded half-up', () => {
    const w = run(freshCompany(), 'save_item', product({ price: '12.345678' })).workspace;
    expect(w.items[0].price).toMatch(/^12\.3457(0*)$/);
  });

  it('PRD-017 cost left empty saves the 0 default [browser part: placeholder shown]', () => {
    expect(itemSpec.blank(freshCompany()).cost).toBe('0');
    expect(run(freshCompany(), 'save_item', product({ cost: '0' })).workspace.items[0].cost).toBe('0');
  });

  it('PRD-018 blank unit saved; the invoice line shows quantity only', () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    [w, item] = withItem(w, { unit: '' }, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '2', price: '20' }]);
    expect(documentView(w, w.documents.find(d => d.id === inv)!).lines[0]).toMatchObject({ quantity: '2', unit: '' });
  });

  it('PRD-019 unit "1000 pcs" saved as text and printed after the quantity [documented limitation; hint "pcs, box, kg…"]', () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    [w, item] = withItem(w, { unit: '1000 pcs' }, { quantity: '500', cost: '10' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '199', price: '20' }]);
    const line = documentView(w, w.documents.find(d => d.id === inv)!).lines[0];
    expect(`${line.quantity} ${line.unit}`).toBe('199 1000 pcs');
    expect(itemSpec.fields.find(f => f.key === 'unit')!.hint).toBe('pcs, box, kg…');
  });

  it('PRD-020 unit of 20 characters accepted; 21 refused', () => {
    expect(run(freshCompany(), 'save_item', product({ unit: 'U'.repeat(20) })).workspace.items[0].unit).toHaveLength(20);
    refused(freshCompany(), 'save_item', product({ unit: 'U'.repeat(21) }), /<=20 characters/);
  });

  it('PRD-021 blank category [documented: new-product form defaults to "General"; a cleared category saves blank and a category plan pays its default rate]', () => {
    expect(itemSpec.blank(freshCompany()).category).toBe('General');
    let w = freshCompany(); let item: string, cust: string;
    w = run(w, 'save_plan', { ...w.plans[0], type: 'category', rate: '2', categoryRates: { Lighting: '5' } }).workspace;
    const emp = run(w, 'save_employee', { name: 'Hamza Khan', role: 'Booker', territory: 'Karachi', salary: '0', allowance: '0', deduction: '0', attendance: 30, active: true });
    w = emp.workspace;
    [w, item] = withItem(w, { category: '' }, { quantity: '5', cost: '10' });
    expect(w.items[0].category).toBe('');
    [w, cust] = withParty(w);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100', employeeId: emp.recordId }]);
    expect(w.commissions[0].earned).toBe('2.0000');
  });

  it('PRD-022 reorder level 0 with stock shows "available"', () => {
    const [w] = withItem(freshCompany(), { sku: 'R0', reorderLevel: 0 }, { quantity: '5', cost: '10' });
    expect(badgeFor(invHtml(w), 'R0')).toEqual(['success', 'available']);
  });

  it('PRD-023 reorder level 10 with stock 5 shows the "low stock" badge (Overview queue: see INV-046)', () => {
    const [w] = withItem(freshCompany(), { sku: 'R10', reorderLevel: 10 }, { quantity: '5', cost: '10' });
    expect(badgeFor(invHtml(w), 'R10')).toEqual(['warning', 'low stock']);
  });

  it('PRD-024 reorder level -1 refused [browser part: min 0]', () => {
    refused(freshCompany(), 'save_item', product({ reorderLevel: -1 }), /"reorderLevel"[\s\S]*>=0/);
  });

  it('PRD-025 reorder level 2.5 refused (integer)', () => {
    refused(freshCompany(), 'save_item', product({ reorderLevel: 2.5 }), /expected int/);
  });

  it('PRD-026 weight/volume default to 1 when left empty', () => {
    const blank = itemSpec.blank(freshCompany());
    expect([blank.weight, blank.volume]).toEqual(['1', '1']);
    const saved = run(freshCompany(), 'save_item', product({ weight: 1, volume: 1 })).workspace.items[0];
    expect([saved.weight, saved.volume]).toEqual(['1', '1']);
  });

  it('PRD-027 weight 0 accepted; landed cost allocated by weight gives it nothing', () => {
    let w = freshCompany(); let light: string, heavy: string, supp: string, grn: string;
    [w, light] = withItem(w, { weight: '0' });
    [w, heavy] = withItem(w, { weight: '2' });
    expect(w.items.find(i => i.id === light)!.weight).toBe('0');
    [w, supp] = withParty(w, 'supplier');
    [w, grn] = withDocument(w, 'goods_receipt', supp, [{ itemId: light, quantity: '10', price: '100' }, { itemId: heavy, quantity: '10', price: '100' }]);
    const sh = run(w, 'create_shipment', { documentId: grn });
    w = run(sh.workspace, 'add_shipment_cost', { id: sh.recordId, label: 'Freight', amount: '1000', classification: 'inventory', basis: 'weight' }, actor('Accountant')).workspace;
    w = run(w, 'allocate_shipment', { id: sh.recordId }, actor('Accountant')).workspace;
    const allocations = w.shipments[0].allocations;
    expect(allocations.find(a => a.itemId === light)!.amount).toBe('0.0000');
    expect(allocations.find(a => a.itemId === heavy)!.amount).toBe('1000.0000');
    expectInvariants(w);
  });

  it('PRD-028 HS code free text saved', () => {
    expect(run(freshCompany(), 'save_item', product({ hsCode: 'HS 8504.40 / misc' })).workspace.items[0].hsCode).toBe('HS 8504.40 / misc');
  });

  it('PRD-029 opening stock 50 @ 1,500 books 50 units worth Rs 75,000: "Increased stock for 1 product…"', () => {
    const saved = run(freshCompany(), 'save_item', product());
    const r = opening(saved.workspace, saved.recordId, '50', '1500');
    expect(r.message).toBe('Increased stock for 1 product. Inventory value and journal updated.');
    expect(stock(r.workspace, saved.recordId)).toEqual({ quantity: '50.0000', value: '75000.0000', average: '1500.0000' });
  });

  it('PRD-030 opening stock journal is Dr Inventory 1200 75,000 / Cr Owner\'s capital 3000 75,000', () => {
    const saved = run(freshCompany(), 'save_item', product());
    const w = opening(saved.workspace, saved.recordId, '50', '1500').workspace;
    expect(w.journals.at(-1)!.lines).toEqual([{ account: '1200', debit: '75000.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '75000.0000' }]);
    expectInvariants(w);
  });

  it('PRD-031 opening qty 50 with cost empty: product kept with 0 stock and the stock step refused "Amount must be greater than zero."', () => {
    const saved = run(freshCompany(), 'save_item', product());
    const message = errorOf(() => opening(saved.workspace, saved.recordId, '50', ''));
    expect(saved.workspace.items).toHaveLength(1);
    expect(stock(saved.workspace, saved.recordId).quantity).toBe('0.0000');
    expect(message).toContain('Amount must be greater than zero.');
  });

  it('PRD-032 opening qty 0 with a cost books no movement (the form skips the stock command)', () => {
    const saved = run(freshCompany(), 'save_item', product());
    expect(saved.workspace.stockMoves).toEqual([]);
    expect(source('src/components/master-data-view.tsx')).toContain("if (spec.key === 'items' && !record.id && quantity > 0 && result.recordId)");
  });

  it('PRD-033 opening qty -3 refused [browser part: min 0 blocks first]', () => {
    const saved = run(freshCompany(), 'save_item', product());
    refused(saved.workspace, 'bulk_stock_increase', { warehouseId: firstWarehouse(saved.workspace), date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: saved.recordId, quantity: '-3', cost: '10' }] }, 'Amount must be greater than zero.');
  });

  it('PRD-034 opening qty 0.5 (kg) accepted; field step is 0.0001', () => {
    const saved = run(freshCompany(), 'save_item', product({ unit: 'kg' }));
    expect(stock(opening(saved.workspace, saved.recordId, '0.5', '800').workspace, saved.recordId)).toEqual({ quantity: '0.5000', value: '400.0000', average: '800.0000' });
    expect(itemSpec.fields.find(f => f.key === 'openingQuantity')!.step).toBe('0.0001');
  });

  it('PRD-035 opening qty 0.00001 is refused or books nothing; never a zero-quantity movement carrying value', () => {
    const saved = run(freshCompany(), 'save_item', product());
    let w = saved.workspace;
    try { w = opening(w, saved.recordId, '0.00001', '5').workspace; } catch { /* refusal is acceptable */ }
    expect(w.stockMoves.filter(m => Number(m.quantity) === 0 && Number(m.value) !== 0)).toEqual([]);
  });

  it('PRD-036 warehouse select only when there is more than one warehouse', () => {
    const field = itemSpec.fields.find(f => f.key === 'openingWarehouseId')!;
    const one = freshCompany();
    expect(field.hidden!(one)).toBe(true);
    const two = run(one, 'save_warehouse', { name: 'Lahore godown', branchId: 'main' }).workspace;
    expect(field.hidden!(two)).toBe(false);
  });

  it('PRD-037 opening stock into the second warehouse shows only there', () => {
    let w = run(freshCompany(), 'save_warehouse', { name: 'Lahore godown', branchId: 'main' }).workspace;
    let item: string;
    [w, item] = withItem(w, {}, { quantity: '12', cost: '100', warehouseId: 'lahore-godown' });
    expect(stock(w, item, 'lahore-godown').quantity).toBe('12.0000');
    expect(stock(w, item, 'main-store').quantity).toBe('0.0000');
  });

  it('PRD-038 opening stock in a locked month: product saved, stock refused "Accounting period YYYY-MM is locked."', () => {
    const month = today().slice(0, 7);
    const locked = run(freshCompany(), 'set_period', { month, locked: true }, actor('Accountant')).workspace;
    const saved = run(locked, 'save_item', product());
    expect(saved.workspace.items).toHaveLength(1);
    refused(saved.workspace, 'bulk_stock_increase', { warehouseId: firstWarehouse(locked), date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: saved.recordId, quantity: '1', cost: '1' }] }, `Accounting period ${month} is locked.`);
  });

  it('PRD-039 branch-limited Warehouse Manager cannot book opening stock into another branch', () => {
    const w = buildDemoWorkspace();
    refused(w, 'bulk_stock_increase', { warehouseId: 'lhe-main', date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: 'i-1', quantity: '1', cost: '1' }] }, 'This warehouse is outside your permitted branches.', actor('Warehouse Manager', { branchIds: ['karachi'] }));
  });

  it('PRD-040 editing a product has no Opening stock section (newOnly fields) [browser part]', () => {
    expect(itemSpec.fields.filter(f => f.newOnly).map(f => f.key)).toEqual(['openingQuantity', 'openingCost', 'openingWarehouseId']);
    expect(itemSpec.toPayload({ ...run(freshCompany(), 'save_item', product()).workspace.items[0] })).not.toHaveProperty('openingQuantity');
  });

  it('PRD-041 stored price stays as typed ("2400", not "2400.0000") [browser part: edit form display]', () => {
    expect(run(freshCompany(), 'save_item', product({ price: '2400' })).workspace.items[0].price).toBe('2400');
  });

  it('PRD-042 editing SKU to another product\'s SKU: "SKU … already exists."', () => {
    let w = run(freshCompany(), 'save_item', product()).workspace;
    const other = run(w, 'save_item', product({ sku: 'KET-18', name: 'Kettle' }));
    w = other.workspace;
    refused(w, 'save_item', product({ id: other.recordId, sku: 'LED-24', name: 'Kettle' }), 'SKU LED-24 already exists.');
  });

  it('PRD-043 editing the price leaves posted documents unchanged [browser part: new invoices prefill the new price]', () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    [w, item] = withItem(w, { price: '2400' }, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '2400' }]);
    const before = structuredClone(w.documents.find(d => d.id === inv));
    w = run(w, 'save_item', { ...itemSpec.toPayload(w.items[0]), price: '2600' }).workspace;
    expect(w.items[0].price).toBe('2600');
    expect(w.documents.find(d => d.id === inv)).toEqual(before);
  });

  it('PRD-044 editing an archived product keeps it archived', () => {
    let w = run(freshCompany(), 'save_item', product()).workspace;
    w = run(w, 'set_archived', { kind: 'item', id: w.items[0].id, archived: true }).workspace;
    w = run(w, 'save_item', { ...itemSpec.toPayload(w.items[0]), name: 'LED Panel 24W v2' }).workspace;
    expect(w.items[0]).toMatchObject({ name: 'LED Panel 24W v2', archived: true });
  });

  it('PRD-045 archiving moves the product to Archived and out of the invoice product list', () => {
    const saved = run(freshCompany(), 'save_item', product());
    const r = run(saved.workspace, 'set_archived', { kind: 'item', id: saved.recordId, archived: true });
    expect(r.message).toBe('LED Panel 24W archived. Stock and history are kept; it no longer appears in new documents.');
    expect(itemSpec.isArchived!(r.workspace.items[0])).toBe(true);
    expect(source('src/components/document-editor.tsx')).toContain('const products = workspace.items.filter(i => !i.archived);');
  });

  it('PRD-046 invoice line with an archived product via API: "{name} is archived. Restore it first."', () => {
    let w = freshCompany(); let item: string, cust: string;
    [w, item] = withItem(w, { name: 'LED Panel 24W' }, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    w = run(w, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1', taxRate: '0' }] }, 'LED Panel 24W is archived. Restore it first.');
  });

  it('PRD-047 restoring brings the product back to the active list', () => {
    const saved = run(freshCompany(), 'save_item', product());
    const archived = run(saved.workspace, 'set_archived', { kind: 'item', id: saved.recordId, archived: true }).workspace;
    const r = run(archived, 'set_archived', { kind: 'item', id: saved.recordId, archived: false });
    expect(r.message).toBe('LED Panel 24W restored.');
    expect('archived' in r.workspace.items[0]).toBe(false);
  });

  it('PRD-048 archiving a product with stock is allowed and valuation still counts it', () => {
    let w = freshCompany(); let item: string;
    [w, item] = withItem(w, {}, { quantity: '50', cost: '1500' });
    w = run(w, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    expect(stockValuation(w).total).toBe('75000.0000');
    expectInvariants(w);
  });

  it('PRD-049 Salesperson archiving via API: "Your role does not permit this action." [browser part: button absent]', () => {
    const saved = run(freshCompany(), 'save_item', product());
    refused(saved.workspace, 'set_archived', { kind: 'item', id: saved.recordId, archived: true }, 'Your role does not permit this action.', actor('Salesperson'));
  });

  it('PRD-050 search by SKU fragment is case-insensitive', () => {
    const w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'KET-18', name: 'Kettle' })).workspace;
    expect(search(w, 'led-2').map(i => i.sku)).toEqual(['LED-24']);
  });

  it('PRD-051 search by Urdu name works', () => {
    const w = run(freshCompany(), 'save_item', product({ name: 'ایل ای ڈی پینل' })).workspace;
    expect(search(w, 'پینل')).toHaveLength(1);
  });

  it('PRD-052 status filter Active/Archived/All counts are correct [browser part: filter control]', () => {
    let w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'KET-18', name: 'Kettle' })).workspace;
    w = run(w, 'set_archived', { kind: 'item', id: w.items[1].id, archived: true }).workspace;
    const all = itemSpec.records(w);
    expect([all.filter(i => !itemSpec.isArchived!(i)).length, all.filter(i => itemSpec.isArchived!(i)).length, all.length]).toEqual([1, 1, 2]);
  });

  it.todo('PRD-053 [browser] "Clear filters" resets search and status');
  it.todo('PRD-054 [browser] products table on phone: horizontal scroll hint, bold first column');

  it('PRD-055 export CSV: items-YYYY-MM-DD.csv, headers from the spec, one row per visible product', () => {
    const w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'KET-18', name: 'Kettle' })).workspace;
    const headers = fields.map(f => f.key);
    expect(headers).toEqual(['sku', 'name', 'category', 'unit', 'price', 'cost', 'hsCode', 'reorderLevel', 'weight', 'volume']);
    const csv = toCsv(w.items as never, headers).split('\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toBe('LED-24,LED Panel 24W,Lighting,pcs,2400,1450,9405.1100,0,0.65,0.008');
    expect(source('src/components/master-data-view.tsx')).toContain('a.download = `${spec.key}-${new Date().toISOString().slice(0, 10)}.csv`');
  });

  it('PRD-056 export with filters applied contains only visible rows', () => {
    const w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'KET-18', name: 'Kettle' })).workspace;
    expect(toCsv(search(w, 'kettle') as never, fields.map(f => f.key)).split('\n')).toHaveLength(2);
    expect(source('src/components/master-data-view.tsx')).toContain('const rows = visible.map(');
  });

  it('PRD-057 Export CSV is disabled when the list is empty', () => {
    expect(source('src/components/master-data-view.tsx')).toContain('onClick={exportCsv} disabled={!visible.length}');
  });

  it('PRD-058 export quotes a name containing commas and quotes', () => {
    expect(toCsv([{ sku: 'Q-1', name: 'Panel, 24W "Pro"' }], ['sku', 'name'])).toBe('sku,name\nQ-1,"Panel, 24W ""Pro"""');
  });

  it('PRD-059 export of Unicode text [documented: plain UTF-8 without BOM, text/csv;charset=utf-8] [manual part: open in Excel on Windows]', () => {
    const csv = toCsv([{ sku: 'U-1', name: 'پنکھا' }], ['sku', 'name']);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv).toContain('پنکھا');
    expect(source('src/components/master-data-view.tsx')).toContain("type: 'text/csv;charset=utf-8'");
  });

  it('PRD-060 import template headers are sku,name,category,unit,price,cost,… with an example row', () => {
    expect(fields.map(f => f.key).slice(0, 6)).toEqual(['sku', 'name', 'category', 'unit', 'price', 'cost']);
    expect(source('src/components/csv-import-dialog.tsx')).toContain("a.download = `${spec.key}-template.csv`");
  });

  it('PRD-061 importing 5 valid rows creates 5 products', () => {
    const r = run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(5) });
    expect(r.message).toBe('Imported 5 items: 5 created, 0 updated.');
    expect(r.workspace.items).toHaveLength(5);
  });

  it('PRD-062 header "Item Code" auto-maps to sku', () => {
    expect(mapHeader('Item Code', fields)).toBe('sku');
    expect(mapHeader('item_code', fields)).toBe('sku');
    expect(mapHeader('Product Name', fields)).toBe('name');
  });

  it('PRD-063 a row missing its SKU: "Nothing was imported. Fix these rows…" with the row number; zero imported', () => {
    refused(freshCompany(), 'import_records', { kind: 'items', rows: [...importRows(2), { name: 'No code', price: '5' }] }, 'Nothing was imported. Fix these rows and try again:\nRow 4: SKU is required');
  });

  it('PRD-064 two rows with the same SKU: "SKU X appears more than once in the file"; nothing imported', () => {
    refused(freshCompany(), 'import_records', { kind: 'items', rows: [{ sku: 'X-1', name: 'One' }, { sku: 'x-1', name: 'Two' }] }, 'Row 3: SKU x-1 appears more than once in the file');
  });

  it('PRD-065 SKU already existing in create mode: "SKU X already exists"; nothing imported', () => {
    const w = run(freshCompany(), 'save_item', product()).workspace;
    refused(w, 'import_records', { kind: 'items', rows: [{ sku: 'NEW-1', name: 'New one' }, { sku: 'LED-24', name: 'Dup' }] }, 'Row 3: SKU LED-24 already exists');
  });

  it('PRD-066 update mode updates existing SKUs in place and creates new ones', () => {
    const w = run(freshCompany(), 'save_item', product()).workspace;
    const r = run(w, 'import_records', { kind: 'items', mode: 'upsert', rows: [{ sku: 'LED-24', price: '2500' }, { sku: 'NEW-1', name: 'New one' }] });
    expect(r.message).toBe('Imported 2 items: 1 created, 1 updated.');
    expect(r.workspace.items.find(i => i.sku === 'LED-24')).toMatchObject({ id: w.items[0].id, price: '2500', name: 'LED Panel 24W' });
  });

  it('PRD-067 price "abc" in a row: row error and nothing imported', () => {
    refused(freshCompany(), 'import_records', { kind: 'items', rows: [...importRows(1), { sku: 'BAD', name: 'Bad price', price: 'abc' }] }, /^Nothing was imported[\s\S]*Row 3:/);
  });

  it('PRD-068 negative price row is a row error', () => {
    refused(freshCompany(), 'import_records', { kind: 'items', rows: [{ sku: 'NEG', name: 'Negative', price: '-1' }] }, /Row 2:[\s\S]*Amount cannot be negative\./);
  });

  it('PRD-069 500 rows import [browser part: list stays responsive]', () => {
    const start = performance.now();
    const r = run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(500) });
    expect(r.workspace.items).toHaveLength(500);
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it('PRD-070 more than 500 rows [documented: limit is 2,000 rows per file; 2,001 refused by the API and by the dialog "Import at most 2,000 rows at a time."]', () => {
    expect(run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(501) }).workspace.items).toHaveLength(501);
    refused(freshCompany(), 'import_records', { kind: 'items', rows: importRows(2001) }, /<=2000 items/);
    expect(source('src/components/csv-import-dialog.tsx')).toContain("'Import at most 2,000 rows at a time.'");
  });

  it('PRD-071 empty file: "The file has no data rows." (API also refuses zero rows)', () => {
    const parsed = parse('');
    expect(!(parsed.meta.fields ?? []).length || !parsed.data.length).toBe(true);
    expect(source('src/components/csv-import-dialog.tsx')).toContain("setError('The file has no data rows.')");
    refused(freshCompany(), 'import_records', { kind: 'items', rows: [] }, />=1 items/);
  });

  it('PRD-072 file with only headers gives the same "no data rows" result', () => {
    const parsed = parse('sku,name,price\n');
    expect(parsed.meta.fields).toEqual(['sku', 'name', 'price']);
    expect(parsed.data).toEqual([]);
  });

  it('PRD-073 Windows line endings are parsed', () => {
    const parsed = parse('sku,name,price\r\nA-1,Alpha,100\r\nB-2,Beta,200\r\n');
    expect(parsed.data).toEqual([{ sku: 'A-1', name: 'Alpha', price: '100' }, { sku: 'B-2', name: 'Beta', price: '200' }]);
  });

  it('PRD-074 semicolon-delimited file [documented: the parser auto-detects ";" so columns map correctly rather than failing]', () => {
    const parsed = parse('sku;name;price\nA-1;Alpha;100\n');
    expect(parsed.meta.fields).toEqual(['sku', 'name', 'price']);
    expect(parsed.data[0]).toEqual({ sku: 'A-1', name: 'Alpha', price: '100' });
  });

  it('PRD-075 .xlsx is refused by the file picker type filter [browser part: forcing an xlsx]', () => {
    expect(source('src/components/csv-import-dialog.tsx')).toContain('accept=".csv,text/csv"');
  });

  it.todo('PRD-076 [browser] 20 MB CSV is refused or parsed without freezing the browser');

  it('PRD-077 quoted fields with embedded commas and newlines parse correctly', () => {
    const parsed = parse('sku,name,price\nA-1,"Panel, 24W\nwith driver",100\n');
    expect(parsed.data).toEqual([{ sku: 'A-1', name: 'Panel, 24W\nwith driver', price: '100' }]);
  });

  it('PRD-078 UTF-8 BOM at start: first header still maps', () => {
    const parsed = parse('﻿Item Code,name,price\nA-1,Alpha,100\n');
    expect(mapHeader(parsed.meta.fields![0], fields)).toBe('sku');
  });

  it('PRD-079 required column unmapped disables Import with a hint listing it', () => {
    const required = fields.filter(f => f.required).map(f => f.key);
    expect(required).toEqual(['sku', 'name', 'price']);
    const dialog = source('src/components/csv-import-dialog.tsx');
    expect(dialog).toContain('disabled={!parsed || busy || required.length > 0}');
    expect(dialog).toContain('Missing required column');
  });

  it('PRD-080 error list shows at most 20 rows then "…and N more"', () => {
    const text = refused(freshCompany(), 'import_records', { kind: 'items', rows: Array.from({ length: 25 }, () => ({ name: 'No sku' })) }, '…and 5 more');
    expect(text.split('\n').filter(l => l.startsWith('Row '))).toHaveLength(20);
  });

  it('PRD-081 import as Salesperson refused by the API [browser part: button absent]', () => {
    refused(freshCompany(), 'import_records', { kind: 'items', rows: importRows(1) }, 'Your role does not permit this action.', actor('Salesperson'));
  });

  it('PRD-082 import never creates stock', () => {
    const w = run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(3) }).workspace;
    expect(w.stockMoves).toEqual([]);
    expect(w.journals).toEqual([]);
  });

  it('PRD-083 import is atomic: one bad row creates zero products', () => {
    const w = freshCompany();
    refused(w, 'import_records', { kind: 'items', rows: [...importRows(9), { sku: 'BAD', name: 'X' }] }, 'Row 11:');
    expect(w.items).toHaveLength(0);
  });

  it('PRD-084 retrying an import with the same idempotency key creates no duplicates [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    const first = run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(4) }, owner, 'qa-prd-084-import');
    const retry = run(first.workspace, 'import_records', { kind: 'items', rows: importRows(4) }, owner, 'qa-prd-084-import');
    expect([retry.recordId, retry.message]).toEqual([first.recordId, first.message]);
    expect(retry.workspace.items).toHaveLength(4);
  });

  it('PRD-085 product view data: stock by warehouse and movement history [browser part: Item details dialog]', () => {
    let w = run(freshCompany(), 'save_warehouse', { name: 'Lahore godown', branchId: 'main' }).workspace;
    let item: string;
    [w, item] = withItem(w, {}, { quantity: '10', cost: '100' });
    w = run(w, 'stock_transfer', { itemId: item, from: 'main-store', to: 'lahore-godown', quantity: '4' }).workspace;
    expect([stock(w, item, 'main-store').quantity, stock(w, item, 'lahore-godown').quantity]).toEqual(['6.0000', '4.0000']);
    expect(stockMovements(w, '2000-01-01', '2999-12-31', item).map(m => [m.type, m.quantity])).toEqual([['adjustment', '10.0000'], ['transfer out', '-4.0000'], ['transfer in', '4.0000']]);
  });

  it('PRD-086 set quantity (count correction) from the product context works', () => {
    let w = freshCompany(); let item: string;
    [w, item] = withItem(w, {}, { quantity: '50', cost: '1500' });
    const r = run(w, 'set_stock_quantity', { itemId: item, warehouseId: firstWarehouse(w), expectedQuantity: '50', targetQuantity: '45', date: today(), reason: 'Counted' });
    expect(stock(r.workspace, item).quantity).toBe('45.0000');
  });

  it('PRD-087 required flags on sku, name and price in the spec [browser part: asterisks]', () => {
    expect(itemSpec.fields.filter(f => f.required).map(f => f.key)).toEqual(['sku', 'name', 'price']);
  });

  it.todo('PRD-088 [browser] placeholders grey, typed values dark');

  it('PRD-089 "Opening stock" section heading precedes the opening fields [browser part: separating rule]', () => {
    expect(itemSpec.fields.find(f => f.key === 'openingQuantity')!.section).toBe('Opening stock');
  });

  it.todo('PRD-090 [browser] product dialog on phone is a bottom sheet with sticky actions');
  it.todo('PRD-091 [browser] Cancel after typing saves nothing');
  it.todo('PRD-092 [browser] Escape closes the dialog and saves nothing');
  it.todo('PRD-093 [browser] Enter in the SKU field submits and saves');

  it('PRD-094 product name of 120 characters accepted; 121 refused', () => {
    expect(run(freshCompany(), 'save_item', product({ name: 'P'.repeat(120) })).workspace.items[0].name).toHaveLength(120);
    refused(freshCompany(), 'save_item', product({ name: 'P'.repeat(121) }), /<=120 characters/);
  });

  it('PRD-095 a name of only spaces is refused (trim → <2)', () => {
    let error: unknown;
    try { run(freshCompany(), 'save_item', product({ name: '     ' })); } catch (e) { error = e; }
    expect(error, 'whitespace-only product name should be refused').toBeInstanceOf(Error);
  });

  it('PRD-096 same name with a different SKU is allowed', () => {
    const w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'LED-24B' })).workspace;
    expect(w.items.map(i => i.name)).toEqual(['LED Panel 24W', 'LED Panel 24W']);
  });

  it('PRD-097 product count in the Features hide dialog matches (archived included)', () => {
    let w = run(run(freshCompany(), 'save_item', product()).workspace, 'save_item', product({ sku: 'K', name: 'Kettle' })).workspace;
    w = run(w, 'set_archived', { kind: 'item', id: w.items[0].id, archived: true }).workspace;
    expect(moduleRecordCounts(w, 'inventory')[0]).toEqual({ label: 'products', count: 2 });
  });

  it('PRD-098 search over 5,000 products runs under 300 ms [browser part: invoice product select usability]', () => {
    const w = run(freshCompany(), 'save_item', product()).workspace;
    const big: Workspace = { ...w, items: Array.from({ length: 5000 }, (_, i) => ({ ...w.items[0], id: `item-${i}`, sku: `BULK-${i}`, name: `Bulk product ${i}` })) };
    expect(big.items).toHaveLength(5000);
    const start = performance.now();
    const hits = search(big, 'bulk-1999');
    expect(performance.now() - start).toBeLessThan(300);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('PRD-099 price is shown formatted as "Rs 2,400" in the list', () => {
    expect(formatMoney('2400')).toBe('Rs 2,400');
    expect(itemSpec.fields.find(f => f.key === 'price')!.type).toBe('money');
  });

  it('PRD-100 end to end: import 10 → opening stock on two → sell one → export reflects data, stock correct', () => {
    let w = run(freshCompany(), 'import_records', { kind: 'items', rows: importRows(10) }).workspace;
    const [a, b] = w.items;
    w = run(w, 'bulk_stock_increase', { warehouseId: firstWarehouse(w), date: today(), purpose: 'opening_stock', reason: 'Opening', lines: [{ itemId: a.id, quantity: '20', cost: '50' }, { itemId: b.id, quantity: '10', cost: '70' }] }).workspace;
    let cust: string;
    [w, cust] = withParty(w);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: a.id, quantity: '3', price: '100' }]);
    expect(stock(w, a.id)).toEqual({ quantity: '17.0000', value: '850.0000', average: '50.0000' });
    expect(stock(w, b.id).quantity).toBe('10.0000');
    const csv = toCsv(w.items as never, fields.map(f => f.key)).split('\n');
    expect(csv).toHaveLength(11);
    expect(csv[1].startsWith('IMP-1,Imported product 1,General,pcs,100,50')).toBe(true);
    expect(accountBalance(w, '1200')).toBe('1550.0000');
    expectInvariants(w);
  });
});
