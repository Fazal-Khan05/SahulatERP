import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { saveAdjustmentDraft, saveTransferDraft, startCount } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { saveDraft as saveManualJournal } from "@/modules/manual-journals/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { setAccountBalance, startOpening } from "@/modules/opening/commands";
import { createParty } from "@/modules/parties/commands";
import { saveOrderDraft, saveReceiptDraft as saveGoodsReceived, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import { saveReceiptDraft as saveMoneyReceived } from "@/modules/receipts/commands";
import { saveSalesDraft, startDelivery, submitSalesDocument } from "@/modules/sales/commands";
import { saveBillDraft } from "@/modules/supplier-bills/commands";
import { savePaymentDraft } from "@/modules/supplier-payments/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../tests/support/admin-db";
import { seedStock } from "../../tests/support/stock";

// drizzle/0033_line_guards.sql. The lines of a document are guarded by a trigger that first
// looks the document up and holds it. One session can remove a draft and write it again under
// the same id while another session's new line is waiting for it: the waiting line's guard
// then finds nothing where the draft was. It used to let the line through unchecked ("a line of
// no document is left for the foreign key to refuse"), while the policy still saw the old draft
// and the foreign key saw the new row, whatever state that was in by then. So a line could be
// written into a document that had been posted in between, with none of the guard's checks.
//
// Each test here runs that race, with two real sessions, against one table: the waiting line
// must be refused, in the words the policy uses for a document that is not there. Before the
// migration every one of them fails. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-line-guard-test";
const tenant = randomUUID();
const ownerId = randomUUID();
const branch = randomUUID();
const mainWarehouse = randomUUID();
const cityWarehouse = randomUUID();
const north = randomUUID();
const northWarehouse = randomUUID();
const farWarehouse = randomUUID();
/** An accountant who works in the main branch only. */
const mainAccountantId = randomUUID();
const owner: TenantContext = { userId: ownerId, email: "owner@line-guard.test", tenantId: tenant, tenantName: "x", role: "owner", branchIds: null };
const DAY = "2026-11-03";

let admin: AdminSql;
let cash = "";
let rent = "";
let helmet = "";
let grip = "";
let chain = "";
let supplier = "";
let customer = "";

/** The database's code for what a statement run by the owner was refused with, or undefined when it went through. */
async function codeOf(statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(ownerId, tenant, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

/** The columns of a table the app's role may name when it inserts a row, other than the ones the database fills in. */
async function insertable(table: string): Promise<string[]> {
  const rows = await admin<{ name: string }[]>`
    select a.attname as name from pg_attribute a
    where a.attrelid = ${"public." + table}::regclass and a.attnum > 0 and not a.attisdropped and a.attname not in ('id', 'created_at')
      and has_column_privilege('app_runtime', a.attrelid, a.attnum, 'INSERT')
    order by a.attnum`;
  return rows.map((row) => row.name);
}

/** A row of a table written from its JSON, naming the columns given: `insert into t (a, b) select a, b from jsonb_populate_record(...)`. */
const insertRow = (table: string, columns: string[], row: unknown) =>
  sql`insert into ${sql.raw(`public.${table} (${columns.join(", ")})`)} select ${sql.raw(columns.join(", "))} from jsonb_populate_record(null::${sql.raw(`public.${table}`)}, ${JSON.stringify(row)}::jsonb)`;

type Race = {
  /** The document's table, and the id of a draft of it. */
  header: string;
  id: string;
  /** The table of its lines, and the column of a line that names its document. */
  lines: string;
  parent: string;
  /** Tables whose rows of this document are removed first, in order, so that the document itself can be removed. */
  clear: [table: string, column: string][];
  /** Tables whose rows the first session writes again with the document, from what they were. */
  restore?: string[];
  /** A line to write when the draft has none to copy. */
  line?: Record<string, unknown>;
};

/**
 * Runs the race. One session removes the draft and writes it again under the same id, and stays
 * open; a second session then writes a line into it, and waits. Returns what the second session
 * was refused with (undefined if its line went in), and how many lines the document ends with.
 */
async function race(test: Race): Promise<{ refused: string | undefined; lines: number }> {
  const [{ row: header }] = await admin<{ row: unknown }[]>`select to_jsonb(d) as row from ${admin("public." + test.header)} d where d.id = ${test.id}`;
  const template = test.line ?? (await admin<{ row: Record<string, unknown> }[]>`select to_jsonb(l) as row from ${admin("public." + test.lines)} l where ${admin(test.parent)} = ${test.id} limit 1`)[0].row;
  const kept: [string, unknown[]][] = [];
  for (const table of test.restore ?? []) {
    const column = test.clear.find(([name]) => name === table)![1];
    kept.push([table, (await admin<{ row: unknown }[]>`select to_jsonb(r) as row from ${admin("public." + table)} r where ${admin(column)} = ${test.id}`).map((r) => r.row)]);
  }
  const headerColumns = await insertable(test.header);
  const lineColumns = (await insertable(test.lines)).filter((column) => template[column] !== undefined && template[column] !== null);
  let rewritten!: () => void;
  const open = new Promise<void>((resolve) => (rewritten = resolve));
  const first = withTenant(ownerId, tenant, async (tx) => {
    for (const [table, column] of test.clear) await tx.execute(sql`delete from ${sql.raw(`public.${table}`)} where ${sql.raw(column)} = ${test.id}`);
    await tx.execute(sql`delete from ${sql.raw(`public.${test.header}`)} where id = ${test.id}`);
    await tx.execute(insertRow(test.header, ["id", ...headerColumns], header));
    for (const [table, rows] of kept) for (const row of rows) await tx.execute(insertRow(table, ["id", ...(await insertable(table))].filter((column) => (row as Record<string, unknown>)[column] !== null), row));
    rewritten();
    await tx.execute(sql`select pg_sleep(1)`);
  });
  await open;
  const refused = await codeOf(insertRow(test.lines, lineColumns, { ...template, [test.parent]: test.id, line_no: 99 }));
  await first;
  const restored = (test.restore ?? []).includes(test.lines) ? kept.find(([table]) => table === test.lines)![1].length : 0;
  const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from ${admin("public." + test.lines)} where ${admin(test.parent)} = ${test.id}`;
  return { refused, lines: n - restored };
}

const REFUSED = { refused: "42501", lines: 0 };

describe.skipIf(!hasDb)("no line slips into a document that was removed and written again while the line waited", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${ownerId})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenant}, 'Main', ${ownerId})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${north}, ${tenant}, 'North', ${ownerId})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenant}, ${branch}, 'Main store', ${ownerId}), (${cityWarehouse}, ${tenant}, ${branch}, 'City store', ${ownerId}), (${northWarehouse}, ${tenant}, ${north}, 'North store', ${ownerId}), (${farWarehouse}, ${tenant}, ${north}, 'Far store', ${ownerId})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, branch_ids, created_by) values (${tenant}, ${ownerId}, ${owner.email}, 'owner', null, ${ownerId}), (${tenant}, ${mainAccountantId}, 'main@line-guard.test', 'accountant', ${[branch]}, ${ownerId})`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenant}, true, '1234567890123', now(), 'trading', ${ownerId})`;
    await admin`select app.seed_tax_defaults(${tenant}, ${ownerId})`;
    await setBaseCurrency(owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(owner, "trading");
    await openFiscalYear(owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = ${code}`)[0].id;
    cash = await account("1111");
    rent = await account("5230");
    const piece = (await addUnit(owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1500" })).id;
    grip = (await createItem(owner, { code: "GR-2", name: "Grip", unit: piece, defaultPrice: "50" })).id;
    chain = (await createItem(owner, { code: "CH-3", name: "Chain", unit: piece, defaultPrice: "300" })).id;
    supplier = (await createParty(owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    customer = (await createParty(owner, "customer", { name: "Registered Dealer", code: "C-001" })).id;
    await seedStock(admin, { tenantId: tenant, itemId: helmet, warehouseId: mainWarehouse, quantity: "20", value: "12000", userId: ownerId });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("manual journals", async () => {
    const { id } = await saveManualJournal(owner, null, { date: DAY, memo: "Shop rent", branchId: "", lines: [{ accountId: rent, description: "Rent", debit: "100", credit: "" }, { accountId: cash, description: "", debit: "", credit: "100" }] });
    expect.soft(await race({ header: "manual_journals", id, lines: "manual_journal_lines", parent: "manual_journal_id", clear: [["manual_journal_lines", "manual_journal_id"]] })).toEqual(REFUSED);
  });

  it("opening balances", async () => {
    const { id } = await startOpening(owner, { date: "2026-07-01" });
    await setAccountBalance(owner, { accountId: cash, debit: "500", credit: "" });
    expect.soft(await race({ header: "opening_entries", id, lines: "opening_balances", parent: "opening_entry_id", clear: [["opening_balances", "opening_entry_id"]] })).toEqual(REFUSED);
  });

  it("purchase orders, and goods received", async () => {
    const order = () => saveOrderDraft(owner, null, { date: DAY, supplierId: supplier, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "5", unitCost: "600" }] });
    const draft = await order();
    expect.soft(await race({ header: "purchase_orders", id: draft.id, lines: "purchase_order_lines", parent: "order_id", clear: [["purchase_order_lines", "order_id"]] })).toEqual(REFUSED);
    const placed = await order();
    await submitOrder(owner, placed.id);
    const lines = (await getOrder(owner, placed.id))!.lines;
    const note = await saveGoodsReceived(owner, null, placed.id, { date: DAY, lines: lines.map((line) => ({ orderLineId: line.id, quantity: "2" })) });
    expect.soft(await race({ header: "goods_receipts", id: note.id, lines: "goods_receipt_lines", parent: "receipt_id", clear: [["goods_receipt_lines", "receipt_id"]] })).toEqual(REFUSED);
  });

  it("stock transfers, adjustments and counts", async () => {
    const transfer = await saveTransferDraft(owner, null, { date: DAY, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "2" }] });
    expect.soft(await race({ header: "stock_transfers", id: transfer.id, lines: "stock_transfer_lines", parent: "transfer_id", clear: [["stock_transfer_lines", "transfer_id"]] })).toEqual(REFUSED);
    const adjustment = await saveAdjustmentDraft(owner, "adjustment", null, { date: DAY, warehouseId: mainWarehouse, reason: "found", lines: [{ itemCode: "HL-1", direction: "in", quantity: "1", unitCost: "" }] });
    expect.soft(await race({ header: "stock_adjustments", id: adjustment.id, lines: "stock_adjustment_lines", parent: "adjustment_id", clear: [["stock_adjustment_lines", "adjustment_id"]] })).toEqual(REFUSED);
    const count = await startCount(owner, { date: DAY, warehouseId: mainWarehouse });
    expect.soft(await race({ header: "stock_counts", id: count.id, lines: "stock_count_lines", parent: "count_id", clear: [["stock_count_lines", "count_id"]] })).toEqual(REFUSED);
  });

  it("sales documents: their lines, the salespeople on a line, and what a delivery note was made from", async () => {
    const line = { itemId: helmet, quantity: "1", unitId: "", unitPrice: "", discountPercent: "", description: "" };
    const order = () => saveSalesDraft(owner, null, { kind: "order", date: DAY, customerId: customer, warehouseId: mainWarehouse, lines: [line], shares: [{ userId: ownerId, percent: "100" }] });
    const parts: [string, string][] = [["sales_line_salespeople", "document_id"], ["sales_document_links", "to_document_id"], ["sales_lines", "document_id"]];
    const first = await order();
    expect.soft(await race({ header: "sales_documents", id: first.id, lines: "sales_lines", parent: "document_id", clear: parts })).toEqual(REFUSED);
    // The salespeople of a line: the first session writes the line again too, so that the share has a line to belong to.
    const second = await order();
    expect.soft(await race({ header: "sales_documents", id: second.id, lines: "sales_line_salespeople", parent: "document_id", clear: parts, restore: ["sales_lines"] })).toEqual(REFUSED);
    // A delivery note made from a submitted order is tied to it by a link.
    const placed = await order();
    await submitSalesDocument(owner, placed.id);
    const note = await startDelivery(owner, placed.id);
    expect.soft(await race({ header: "sales_documents", id: note.id, lines: "sales_document_links", parent: "to_document_id", clear: parts })).toEqual(REFUSED);
  });

  it("receipts from customers", async () => {
    const receipt = await saveMoneyReceived(owner, null, { date: DAY, customerId: customer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    // The receipt is an advance, with nothing set against an invoice: the line written into it names a sales order, which no guard would let a receipt pay.
    const order = await saveSalesDraft(owner, null, { kind: "order", date: DAY, customerId: customer, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "1", unitId: "", unitPrice: "", discountPercent: "", description: "" }] });
    const line = { tenant_id: tenant, receipt_id: receipt.id, invoice_id: order.id, amount: "10", created_by: ownerId };
    expect.soft(await race({ header: "receipts", id: receipt.id, lines: "receipt_allocations", parent: "receipt_id", clear: [["receipt_allocations", "receipt_id"]], line })).toEqual(REFUSED);
  });

  it("supplier bills and payments", async () => {
    const bill = () => saveBillDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, supplierInvoiceNo: `INV-${randomUUID().slice(0, 8)}`, expenses: [{ accountId: rent, description: "Advice", amount: "10" }] });
    const draft = await bill();
    expect.soft(await race({ header: "supplier_bills", id: draft.id, lines: "supplier_bill_lines", parent: "bill_id", clear: [["supplier_bill_lines", "bill_id"]] })).toEqual(REFUSED);
    const payment = await savePaymentDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, accountId: cash, amount: "100" });
    // The line written into the payment settles a bill that is only a draft, which the guard would never allow.
    const other = await bill();
    const line = { tenant_id: tenant, payment_id: payment.id, bill_id: other.id, amount: "10", created_by: ownerId };
    expect.soft(await race({ header: "supplier_payments", id: payment.id, lines: "supplier_payment_allocations", parent: "payment_id", clear: [["supplier_payment_allocations", "payment_id"]], line })).toEqual(REFUSED);
  });

  it("the harm it did: a line of a million in a bill that was posted meanwhile", async () => {
    const id = randomUUID();
    const header = sql`insert into public.supplier_bills (id, tenant_id, bill_date, supplier_id, branch_id, supplier_invoice_no, amount, total, created_by, updated_by) values (${id}, ${tenant}, ${DAY}, ${supplier}, ${branch}, 'SWAPPED', 1, 1, ${ownerId}, ${ownerId})`;
    const line = (no: number, amount: number) => sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenant}, ${id}, ${no}, 'expense', ${rent}, 'Advice', ${amount}, ${ownerId})`;
    await withTenant(ownerId, tenant, (tx) => tx.execute(header));
    let posted!: () => void;
    const open = new Promise<void>((resolve) => (posted = resolve));
    const first = withTenant(ownerId, tenant, async (tx) => {
      await tx.execute(sql`delete from public.supplier_bills where id = ${id}`);
      await tx.execute(header);
      await tx.execute(line(1, 1));
      await tx.execute(sql`select app.post_supplier_bill(${id}::uuid)`);
      posted();
      await tx.execute(sql`select pg_sleep(1)`);
    });
    await open;
    expect(await codeOf(line(2, 1000000))).toBe("42501");
    await first;
    const [bill] = await admin<{ status: string; lines: number }[]>`select b.status, (select count(*)::int from public.supplier_bill_lines l where l.bill_id = b.id) as lines from public.supplier_bills b where b.id = ${id}`;
    expect(bill).toEqual({ status: "posted", lines: 1 });
  });

  it("the chart of accounts: no account slips in under a heading that was removed and written again", async () => {
    // A heading of the company's own may be removed while nothing sits under it. Written again
    // under the same id as an ordinary account, it would take an account under it that its
    // guard never checked: under something that is not a heading, as a bank account where no
    // bank heading is, at any depth. The guard's words for a missing heading are the foreign key's.
    const [{ id: expenses }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = '5200'`;
    const heading = randomUUID();
    await withTenant(ownerId, tenant, (tx) => tx.execute(sql`insert into public.accounts (id, tenant_id, parent_id, code, name, type, is_group, created_by) values (${heading}, ${tenant}, ${expenses}, '5390', 'Shop costs', 'expense', true, ${ownerId})`));
    const line = { tenant_id: tenant, parent_id: heading, code: "5391", name: "Rent of the shop", type: "expense", is_group: false, control_type: "bank", created_by: ownerId };
    expect.soft(await race({ header: "accounts", id: heading, lines: "accounts", parent: "parent_id", clear: [], line })).toEqual({ refused: "23503", lines: 0 });
    // A heading that is not there at all is refused as it always was, by the foreign key's code.
    expect(await codeOf(sql`insert into public.accounts (tenant_id, parent_id, code, name, type, is_group, created_by) values (${tenant}, ${randomUUID()}, '5392', 'Nowhere', 'expense', false, ${ownerId})`)).toBe("23503");
  });

  it("no line is moved to another document: the app's role cannot change which document a line belongs to", async () => {
    const parents: [table: string, column: string][] = [
      ["manual_journal_lines", "manual_journal_id"],
      ["opening_balances", "opening_entry_id"],
      ["purchase_order_lines", "order_id"],
      ["goods_receipt_lines", "receipt_id"],
      ["stock_transfer_lines", "transfer_id"],
      ["stock_adjustment_lines", "adjustment_id"],
      ["stock_count_lines", "count_id"],
      ["sales_lines", "document_id"],
      ["sales_line_salespeople", "document_id"],
      ["sales_line_salespeople", "line_id"],
      ["sales_document_links", "to_document_id"],
      ["receipt_allocations", "receipt_id"],
      ["supplier_bill_lines", "bill_id"],
      ["supplier_payment_allocations", "payment_id"],
      ["accounts", "parent_id"],
    ];
    for (const [table, column] of parents) {
      const [{ allowed }] = await admin<{ allowed: boolean }[]>`select has_column_privilege('app_runtime', ${"public." + table}, ${column}, 'UPDATE') as allowed`;
      expect(allowed, `${table}.${column}`).toBe(false);
      expect(await codeOf(sql`update ${sql.raw(`public.${table}`)} set ${sql.raw(column)} = ${randomUUID()} where false`), `${table}.${column}`).toBe("42501");
    }
  });

  it("no line slips into, or out of, a document moved out of the member's branches while the line waited", async () => {
    // Found by this migration's reviewer. The owner moves a draft to the north branch (and could
    // post it); meanwhile an accountant of the main branch writes a line into it, or takes one out.
    // The guard finds the document, now outside the accountant's branches, and used to leave the
    // refusal to the policy, which reads the document as it was when the statement began: still
    // a draft of the main branch. So the row went through unchecked.
    type Moved = { header: string; id: string; lines: string; parent: string; move: ReturnType<typeof sql>; extra?: Record<string, unknown> };
    async function moved(test: Moved, remove: boolean): Promise<{ refused: string | undefined; lines: number }> {
      const [{ row: template }] = await admin<{ row: Record<string, unknown> }[]>`select to_jsonb(l) as row from ${admin("public." + test.lines)} l where ${admin(test.parent)} = ${test.id} order by l.created_at limit 1`;
      const columns = (await insertable(test.lines)).filter((column) => template[column] !== undefined && template[column] !== null);
      const [{ n: before }] = await admin<{ n: number }[]>`select count(*)::int as n from ${admin("public." + test.lines)} where ${admin(test.parent)} = ${test.id}`;
      let held!: () => void;
      const open = new Promise<void>((resolve) => (held = resolve));
      const first = withTenant(ownerId, tenant, async (tx) => {
        await tx.execute(test.move);
        held();
        await tx.execute(sql`select pg_sleep(1)`);
      });
      await open;
      let refused: string | undefined;
      try {
        await withTenant(mainAccountantId, tenant, (tx) =>
          tx.execute(remove
            ? sql`delete from ${sql.raw(`public.${test.lines}`)} where id = ${template.id as string}`
            : insertRow(test.lines, columns, { ...template, line_no: 98, created_by: mainAccountantId, ...test.extra })),
        );
      } catch (error) {
        const e = error as { code?: string; cause?: { code?: string } };
        refused = e.cause?.code ?? e.code ?? "unknown";
      }
      await first;
      const [{ n: after }] = await admin<{ n: number }[]>`select count(*)::int as n from ${admin("public." + test.lines)} where ${admin(test.parent)} = ${test.id}`;
      // Moved back, so the next case starts in the main branch again.
      return { refused, lines: after - before };
    }
    const bill = await saveBillDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, supplierInvoiceNo: "MOVED-1", expenses: [{ accountId: rent, description: "Advice", amount: "10" }, { accountId: rent, description: "More advice", amount: "5" }] });
    const other = await saveBillDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, supplierInvoiceNo: "MOVED-2", expenses: [{ accountId: rent, description: "Advice", amount: "10" }] });
    const payment = await savePaymentDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, accountId: cash, amount: "100" });
    await admin`insert into public.supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, created_by) values (${tenant}, ${payment.id}, ${other.id}, 1, ${ownerId}), (${tenant}, ${payment.id}, ${other.id}, 2, ${ownerId})`;
    const receipt = await saveMoneyReceived(owner, null, { date: DAY, customerId: customer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    const sale = () => saveSalesDraft(owner, null, { kind: "order", date: DAY, customerId: customer, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "1", unitId: "", unitPrice: "", discountPercent: "", description: "" }] });
    const [first, second, third] = [await sale(), await sale(), await sale()];
    await admin`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by) values (${tenant}, ${receipt.id}, ${first.id}, 1, ${ownerId}), (${tenant}, ${receipt.id}, ${second.id}, 2, ${ownerId})`;
    const order = await saveOrderDraft(owner, null, { date: DAY, supplierId: supplier, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "5", unitCost: "600" }, { itemId: helmet, quantity: "1", unitCost: "600" }] });
    const transfer = await saveTransferDraft(owner, null, { date: DAY, fromWarehouseId: mainWarehouse, toWarehouseId: cityWarehouse, lines: [{ itemCode: "HL-1", quantity: "2" }] });
    await admin`insert into public.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, quantity, created_by) values (${tenant}, ${transfer.id}, 2, ${grip}, 1, ${ownerId})`;
    const adjustment = await saveAdjustmentDraft(owner, "adjustment", null, { date: DAY, warehouseId: mainWarehouse, reason: "found", lines: [{ itemCode: "HL-1", direction: "in", quantity: "1", unitCost: "" }] });
    await admin`insert into public.stock_adjustment_lines (tenant_id, adjustment_id, line_no, item_id, quantity, unit_cost, created_by) select tenant_id, adjustment_id, 2, ${grip}, quantity, unit_cost, created_by from public.stock_adjustment_lines where adjustment_id = ${adjustment.id}`;
    const cases: [string, Moved, ReturnType<typeof sql>][] = [
      ["a supplier bill", { header: "supplier_bills", id: bill.id, lines: "supplier_bill_lines", parent: "bill_id", move: sql`update public.supplier_bills set branch_id = ${north}, updated_by = ${ownerId} where id = ${bill.id}` }, sql`update public.supplier_bills set branch_id = ${branch}, updated_by = ${ownerId} where id = ${bill.id}`],
      ["a supplier payment", { header: "supplier_payments", id: payment.id, lines: "supplier_payment_allocations", parent: "payment_id", move: sql`update public.supplier_payments set branch_id = ${north}, updated_by = ${ownerId} where id = ${payment.id}` }, sql`update public.supplier_payments set branch_id = ${branch}, updated_by = ${ownerId} where id = ${payment.id}`],
      ["a receipt", { header: "receipts", id: receipt.id, lines: "receipt_allocations", parent: "receipt_id", move: sql`update public.receipts set branch_id = ${north}, updated_by = ${ownerId} where id = ${receipt.id}`, extra: { invoice_id: third.id } }, sql`update public.receipts set branch_id = ${branch}, updated_by = ${ownerId} where id = ${receipt.id}`],
      ["a purchase order", { header: "purchase_orders", id: order.id, lines: "purchase_order_lines", parent: "order_id", move: sql`update public.purchase_orders set warehouse_id = ${northWarehouse}, updated_by = ${ownerId} where id = ${order.id}` }, sql`update public.purchase_orders set warehouse_id = ${mainWarehouse}, updated_by = ${ownerId} where id = ${order.id}`],
      ["a stock transfer", { header: "stock_transfers", id: transfer.id, lines: "stock_transfer_lines", parent: "transfer_id", move: sql`update public.stock_transfers set from_warehouse_id = ${northWarehouse}, to_warehouse_id = ${farWarehouse}, updated_by = ${ownerId} where id = ${transfer.id}`, extra: { item_id: chain } }, sql`update public.stock_transfers set from_warehouse_id = ${mainWarehouse}, to_warehouse_id = ${cityWarehouse}, updated_by = ${ownerId} where id = ${transfer.id}`],
      ["a stock adjustment", { header: "stock_adjustments", id: adjustment.id, lines: "stock_adjustment_lines", parent: "adjustment_id", move: sql`update public.stock_adjustments set warehouse_id = ${northWarehouse}, updated_by = ${ownerId} where id = ${adjustment.id}`, extra: { item_id: chain } }, sql`update public.stock_adjustments set warehouse_id = ${mainWarehouse}, updated_by = ${ownerId} where id = ${adjustment.id}`],
    ];
    // A receipt may have no branch. Emptied while the line waits, the rule of who may write it
    // comes out unknown, not false; that is refused too (found by this migration's reviewer).
    cases.push(["a receipt whose branch is emptied", { header: "receipts", id: receipt.id, lines: "receipt_allocations", parent: "receipt_id", move: sql`update public.receipts set branch_id = null, updated_by = ${ownerId} where id = ${receipt.id}`, extra: { invoice_id: third.id } }, sql`update public.receipts set branch_id = ${branch}, updated_by = ${ownerId} where id = ${receipt.id}`]);
    for (const [what, test, back] of cases) {
      expect.soft(await moved(test, false), `${what}: a line written in`).toEqual({ refused: "42501", lines: 0 });
      await withTenant(ownerId, tenant, (tx) => tx.execute(back));
      expect.soft(await moved(test, true), `${what}: a line taken out`).toEqual({ refused: "42501", lines: 0 });
      await withTenant(ownerId, tenant, (tx) => tx.execute(back));
    }
    // In the main branch, the same accountant still writes and takes out lines as before.
    expect(await (async () => {
      await withTenant(mainAccountantId, tenant, (tx) => tx.execute(sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenant}, ${bill.id}, 9, 'expense', ${rent}, 'Advice', 1, ${mainAccountantId})`));
      await withTenant(mainAccountantId, tenant, (tx) => tx.execute(sql`delete from public.supplier_bill_lines where bill_id = ${bill.id} and line_no = 9`));
      return "done";
    })()).toBe("done");
  });

  it("a line of a document that is not there at all is refused as it always was, and an honest line still goes in", async () => {
    const missing = randomUUID();
    expect(await codeOf(sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenant}, ${missing}, 1, 'expense', ${rent}, 'Advice', 5, ${ownerId})`)).toBe("42501");
    expect(await codeOf(sql`insert into public.manual_journal_lines (tenant_id, manual_journal_id, line_no, account_id, debit, credit, created_by) values (${tenant}, ${missing}, 1, ${rent}, 5, 0, ${ownerId})`)).toBe("42501");
    const draft = await saveBillDraft(owner, null, { date: DAY, supplierId: supplier, branchId: branch, supplierInvoiceNo: "HONEST-1", expenses: [{ accountId: rent, description: "Advice", amount: "10" }] });
    expect(await codeOf(sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenant}, ${draft.id}, 2, 'expense', ${rent}, 'More advice', 5, ${ownerId})`)).toBeUndefined();
  });
});
