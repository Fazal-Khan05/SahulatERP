import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem, removeItemUnit, setItemUnit } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { addOpenDocument, postOpening, reverseOpening, startOpening } from "@/modules/opening/commands";
import { createParty, setPartyArchived } from "@/modules/parties/commands";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { listOpenItems } from "@/modules/receipts/queries";
import { cancelSalesDocument, discardSalesDraft, postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument, listSalesDocuments } from "@/modules/sales/queries";
import { salesDocuments } from "@/modules/sales/schema";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { enterAs } from "../../../tests/support/identity";
import { seedStock } from "../../../tests/support/stock";
import { applyCredit, postCreditNote, saveCreditNoteDraft, startCreditNote } from "./commands";
import { getCreditNoteFacts, getInvoiceReturns } from "./queries";
import { creditShare } from "./rules";

// Credit notes against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): a partial return posts a partial reversal, returning more than was
// invoiced is refused, goods go back on the shelf or are written off, a return on a paid
// invoice leaves the customer credit, and nothing reaches the books except through the
// database's own posting function. The figures are those of docs/examples/step-21.md.
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-credit-note-test";
const tenantA = randomUUID(); // Lahore Bike Parts: registered for sales tax, prices before tax
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const branch = randomUUID();
const warehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@credit.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");

let admin: AdminSql;
let helmet: string; // 10 that cost 600 each, sold at 1,000
let chain: string; // 20 that cost 270 each, sold at 400
let bolt: string; // 20 worth 100.10 in all, sold at 10.01
let dealer: string; // registered and active
let rider: string; // not registered: further tax applies
let cash: string;
let first: string; // SI-2627-00001: Dealer, from a delivery note: 2 helmets, 5 chains and 7 bolts (5% off the chains and the bolts)
let second: string; // SI-2627-00002: Rider, straight from an order: 1 helmet and 3 chains

/** The database's code for what a statement run as this member was refused with, or undefined when it went through. */
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const line = (itemId: string, quantity: string, discountPercent = "", unitId = "") => ({ itemId, quantity, unitId, unitPrice: "", discountPercent, description: "" });
async function order(customerId: string, date: string, lines: ReturnType<typeof line>[]): Promise<string> {
  const { id } = await saveSalesDraft(as.salesperson, null, { kind: "order", date, customerId, warehouseId: warehouse, lines, shares: [{ userId: userIds.salesperson, percent: "100" }] });
  await submitSalesDocument(as.salesperson, id);
  return id;
}
/** A posted invoice for everything its source still has, dated as given. */
async function invoice(sourceId: string, date: string): Promise<string> {
  const { id } = await startInvoice(as.salesperson, sourceId);
  const draft = (await getSalesDocument(as.salesperson, id))!;
  await saveInvoiceDraft(as.salesperson, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.salesperson, id);
  return id;
}
/** The id of the invoice's line for an item. */
const lineOf = async (invoiceId: string, itemId: string) => (await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${invoiceId} and item_id = ${itemId}`)[0].id;
/** One more draft credit note for an invoice, written past startCreditNote (which opens the draft there already is). */
async function anotherDraft(who: TenantContext, invoiceId: string, date: string): Promise<string> {
  const from = (await getSalesDocument(who, invoiceId))!;
  return withTenant(who.userId, who.tenantId, async (tx) => {
    const [row] = await tx
      .insert(salesDocuments)
      .values({ tenantId: who.tenantId, kind: "credit_note", documentDate: date, customerId: from.customerId, warehouseId: from.warehouseId, branchId: from.branchId, currency: from.currency, exchangeRate: "1", taxed: from.taxed, pricesIncludeTax: from.pricesIncludeTax, furtherTaxExcluded: from.furtherTaxExcluded, sourceDocumentId: from.id, createdBy: who.userId, updatedBy: who.userId })
      .returning({ id: salesDocuments.id });
    return row.id;
  });
}
/** A line written straight into a draft as this member, copied from an invoice line with some of it changed: what the app itself would never write. */
const rawLine = (who: TenantContext, documentId: string, sourceLineId: string, patch: Record<string, string | null>) =>
  codeOf(
    who,
    sql`insert into sales_lines select (jsonb_populate_record(o, ${JSON.stringify({ id: randomUUID(), document_id: documentId, line_no: "1", source_line_id: sourceLineId, damaged_quantity: "0", created_by: who.userId, ...patch })}::jsonb)).* from sales_lines o where o.id = ${sourceLineId}::uuid`,
  );
const journalOf = async (sourceType: string, sourceId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text || coalesce(' (' || c.name || ')', '') as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      left join public.customers c on c.id = l.customer_id
      where j.source_type = ${sourceType} and j.source_id = ${sourceId} order by l.line_no`
  ).map((row) => row.line);
const stock = async (itemId: string) => {
  const [row] = await admin`select quantity::text, value::text from public.stock_balances where item_id = ${itemId}`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};
/** What the books say an account stands at, debit less credit; for one customer when named. */
async function balance(control: string, customerId?: string): Promise<string> {
  const [row] = await admin`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantA} and a.control_type = ${control} and (${customerId ?? null}::uuid is null or l.customer_id = ${customerId ?? null})`;
  return row.v;
}
const open = async (customerId: string) => (await listOpenItems(as.accountant, customerId)).map((item) => `${item.number} ${item.outstanding.toFixed(2)} of ${item.total.toFixed(2)}`);
const figures = (l: { itemCode: string; quantity: Decimal; damagedQuantity: Decimal | null; value: Decimal; taxAmount: Decimal; furtherTaxAmount: Decimal; total: Decimal }) =>
  `${l.itemCode} ${l.quantity.toFixed()} (${l.damagedQuantity?.toFixed() ?? "-"} damaged): ${l.value.toFixed(2)} + ${l.taxAmount.toFixed(2)} + ${l.furtherTaxAmount.toFixed(2)} = ${l.total.toFixed(2)}`;
const back = (sourceLineId: string, quantity: string, damaged = "") => ({ sourceLineId, quantity, damaged });
/** What the customer owes in the books is what the customer's unpaid invoices come to; and the goods on hand are what their moves add up to. */
async function booksAgree(): Promise<void> {
  for (const customer of [dealer, rider]) {
    const unpaid = (await listOpenItems(as.accountant, customer)).reduce((sum, item) => sum.plus(item.outstanding), new Decimal(0));
    expect(await balance("ar", customer), "receivable of the customer").toBe(unpaid.toFixed(2));
  }
  const drift = await admin`
    select i.code from public.stock_balances b join public.items i on i.id = b.item_id
    cross join lateral (select coalesce(sum(m.quantity), 0) as quantity, coalesce(sum(m.value), 0) as value from public.stock_moves m where m.item_id = b.item_id and m.warehouse_id = b.warehouse_id) moved
    where b.tenant_id = ${tenantA} and (b.quantity <> moved.quantity or b.value <> moved.value)`;
  expect(drift.map((row) => row.code)).toEqual([]);
}

describe.skipIf(!hasDb)("credit notes", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'Main', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenantA}, ${branch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    cash = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1111'`)[0].id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    bolt = (await createItem(as.owner, { code: "BT-3", name: "Bolt", unit: piece, defaultPrice: "10.01" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Registered Dealer", code: "C-001", registrationType: "registered", ntn: "1234567", strn: "3277876123456", atlStatus: "active", creditDays: "30" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Walk-in Rider", code: "C-002" })).id;
    const seed = { tenantId: tenantA, warehouseId: warehouse, userId: userIds.owner };
    await seedStock(admin, { ...seed, itemId: helmet, quantity: "10", value: "6000" });
    await seedStock(admin, { ...seed, itemId: chain, quantity: "20", value: "5400" });
    await seedStock(admin, { ...seed, itemId: bolt, quantity: "20", value: "100.10" });
    // The books open on 1 October: Walk-in Rider still owes 500 on an old invoice.
    await startOpening(as.owner, { date: "2026-10-01" });
    await addOpenDocument(as.owner, "receivable", { party: "C-002", documentNumber: "OLD-9", documentDate: "2026-09-05", dueDate: "2026-09-20", amount: "500" });
    await postOpening(as.owner);

    // 10 October: 2 helmets, 5 chains and 7 bolts are delivered to Registered Dealer; invoiced on the 12th.
    const order1 = await order(dealer, "2026-10-10", [line(helmet, "2"), line(chain, "5", "5"), line(bolt, "7", "5")]);
    const { id: note } = await startDelivery(as.warehouse_manager, order1);
    const draft = (await getSalesDocument(as.warehouse_manager, note))!;
    await saveDeliveryDraft(as.warehouse_manager, note, { date: "2026-10-10", lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
    await postDelivery(as.warehouse_manager, note);
    first = await invoice(note, "2026-10-12");
    // 13 October: 1 helmet and 3 chains go straight from an order to Walk-in Rider, who is not registered.
    second = await invoice(await order(rider, "2026-10-13", [line(helmet, "1"), line(chain, "3")]), "2026-10-13");
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("starts from the invoices of the worked example", async () => {
    expect((await getSalesDocument(as.auditor, first))!.lines.map(figures)).toEqual([
      "HL-1 2 (- damaged): 2000.00 + 360.00 + 0.00 = 2360.00",
      "CH-2 5 (- damaged): 1900.00 + 342.00 + 0.00 = 2242.00",
      "BT-3 7 (- damaged): 66.57 + 11.98 + 0.00 = 78.55",
    ]);
    expect((await getSalesDocument(as.auditor, second))!.lines.map(figures)).toEqual(["HL-1 1 (- damaged): 1000.00 + 180.00 + 40.00 = 1220.00", "CH-2 3 (- damaged): 1200.00 + 216.00 + 48.00 = 1464.00"]);
    expect(await open(dealer)).toEqual(["SI-2627-00001 4680.55 of 4680.55"]);
    expect(await stock(chain)).toBe("12 worth 3240");
    await booksAgree();
  });

  it("is written by the owner, an accountant or the sales manager, from a posted invoice", async () => {
    for (const role of ["salesperson", "warehouse_manager", "auditor", "recovery_officer"] as const) {
      await expect(startCreditNote(as[role], first), role).rejects.toThrow("Only an owner, an accountant or the sales manager can write a credit note.");
    }
    // The database says the same to a salesperson who writes one past the app, though the invoice is their own sale.
    const forged = sql`insert into sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, taxed, prices_include_tax, source_document_id, created_by, updated_by)
      select tenant_id, 'credit_note', document_date, customer_id, warehouse_id, branch_id, currency, taxed, prices_include_tax, id, ${userIds.salesperson}::uuid, ${userIds.salesperson}::uuid from sales_documents where id = ${first}::uuid`;
    expect(await codeOf(as.salesperson, forged)).toBe("42501");
    // Only an invoice, and only a posted one, of this company.
    const anOrder = (await getSalesDocument(as.owner, first))!.source!.id;
    await expect(startCreditNote(as.sales_manager, anOrder)).rejects.toThrow("A credit note is made from a sales invoice.");
    await expect(startCreditNote(otherOwner, first)).rejects.toThrow("A credit note is made from a sales invoice.");

    const { id } = await startCreditNote(as.sales_manager, first);
    // Asking again opens the same draft, not a second one.
    expect((await startCreditNote(as.accountant, first)).id).toBe(id);
    const draft = await getSalesDocument(as.sales_manager, id);
    expect(draft).toMatchObject({ kind: "credit_note", status: "draft", number: null, taxed: true, pricesIncludeTax: false, customerId: dealer, warehouseId: warehouse, source: { id: first, kind: "invoice", number: "SI-2627-00001" }, lines: [] });
    // It is filed under whoever the invoice is filed under, so that salesperson sees it; they cannot change it or throw it away.
    expect((await getSalesDocument(as.salesperson, id))?.salespersonId).toBe(userIds.salesperson);
    await expect(saveCreditNoteDraft(as.salesperson, id, { date: "2026-10-20", lines: [] })).rejects.toThrow("Only an owner, an accountant or the sales manager");
    await expect(discardSalesDraft(as.salesperson, id)).rejects.toThrow("Only an owner, an accountant or the sales manager");
    expect(await codeOf(as.salesperson, sql`delete from sales_documents where id = ${id}::uuid`)).toBe("42501");
    expect(await getSalesDocument(otherOwner, id)).toBeNull();
    // A draft is thrown away like any other, and leaves nothing behind.
    expect(await discardSalesDraft(as.sales_manager, id)).toEqual({ kind: "credit_note" });
    expect(await getSalesDocument(as.owner, id)).toBeNull();
  });

  it("posts a partial return as a partial reversal: some goods back on the shelf, some written off", async () => {
    // 20 October: Registered Dealer sends back 2 of the 5 chains; one of them is damaged.
    const { id } = await startCreditNote(as.sales_manager, first);
    const chains = await lineOf(first, chain);
    await expect(saveCreditNoteDraft(as.sales_manager, id, { date: "2026-10-11", lines: [back(chains, "2")] })).rejects.toThrow("A credit note is dated on or after its invoice.");
    await expect(saveCreditNoteDraft(as.sales_manager, id, { date: "2026-10-20", lines: [back(chains, "2", "3")] })).rejects.toThrow("no more can be damaged than came back");
    await expect(saveCreditNoteDraft(as.sales_manager, id, { date: "2026-10-20", lines: [back(chains, "6")] })).rejects.toThrow("CH-2: the invoice billed 5, so 6 cannot come back.");
    await expect(postCreditNote(as.sales_manager, id)).rejects.toThrow("Enter how much of at least one line came back.");
    await saveCreditNoteDraft(as.sales_manager, id, { date: "2026-10-20", notes: "Two chains sent back, one with a bent link", reference: "DN-88/26", lines: [back(chains, "2", "1")] });
    const draft = (await getSalesDocument(as.sales_manager, id))!;
    // Two fifths of what the invoice line billed: 1,900 and 342.
    expect(draft.lines.map(figures)).toEqual(["CH-2 2 (1 damaged): 760.00 + 136.80 + 0.00 = 896.80"]);
    expect(`${draft.totals.gross.toFixed(2)} ${draft.totals.discount.toFixed(2)} ${draft.totals.value.toFixed(2)} ${draft.totals.tax.toFixed(2)} ${draft.totals.total.toFixed(2)}`).toBe("800.00 40.00 760.00 136.80 896.80");
    // Nothing has reached the books or the stock.
    expect(await journalOf("credit_note", id)).toEqual([]);
    expect(await stock(chain)).toBe("12 worth 3240");
    expect(await open(dealer)).toEqual(["SI-2627-00001 4680.55 of 4680.55"]);

    for (const role of ["salesperson", "auditor"] as const) await expect(postCreditNote(as[role], id), role).rejects.toThrow("Only an owner, an accountant or the sales manager");
    expect(await codeOf(as.salesperson, sql`select * from app.post_credit_note(${id}::uuid)`)).toBe("42501");
    const posted = await postCreditNote(as.sales_manager, id);
    expect({ number: posted.number, setAgainstInvoice: posted.setAgainstInvoice.toFixed(2), leftAsCredit: posted.leftAsCredit.toFixed(2) }).toEqual({ number: "CN-2627-00001", setAgainstInvoice: "896.80", leftAsCredit: "0.00" });
    // The five chains had cost 1,350 when they left; two fifths of that came back: 270 onto the shelf, 270 written off.
    expect(await journalOf("credit_note", id)).toEqual([
      "4100 Sales: 760 / 0",
      "2200 Sales tax payable (output tax): 136.8 / 0",
      "1200 Trade receivables: 0 / 896.8 (Registered Dealer)",
      "1300 Stock in trade: 270 / 0",
      "5110 Stock adjustments: 270 / 0",
      "5100 Cost of goods sold: 0 / 540",
    ]);
    expect(await stock(chain)).toBe("13 worth 3510");
    const moves = await admin`select quantity::text, value::text, source_type, move_date::text from public.stock_moves where source_id = ${id}`;
    expect(moves.map((m) => `${m.quantity} ${m.value} ${m.source_type} ${m.move_date}`)).toEqual(["1.0000 270.0000 credit_note 2026-10-20"]);
    expect(await open(dealer)).toEqual(["SI-2627-00001 3783.75 of 4680.55"]);
    expect(await getSalesDocument(as.auditor, id)).toMatchObject({ status: "submitted", number: "CN-2627-00001", customerName: "Registered Dealer", dueDate: null, customerReference: "DN-88/26", notes: "Two chains sent back, one with a bent link" });
    const facts = await getCreditNoteFacts(as.sales_manager, (await getSalesDocument(as.sales_manager, id))!);
    expect(facts.settled.map((row) => `${row.number} ${row.amount.toFixed(2)} ${row.allocatedOn} ${row.later}`)).toEqual(["SI-2627-00001 896.80 2026-10-20 false"]);
    expect(facts.left.toFixed(2)).toBe("0.00");
    // The audit log has the credit note taking its number and what it did.
    const log = await admin`select action from public.audit_log where entity_id = ${id}`;
    expect(log.map((row) => row.action)).toEqual(expect.arrayContaining(["sales_credit_note.create", "sales_credit_note.update", "sales_credit_note.submit", "credit_note.post"]));
    // It is on the list of credit notes, and on its invoice's page.
    expect((await listSalesDocuments(as.sales_manager, { kind: "credit_note" })).rows.map((row) => `${row.number} ${row.total.toFixed(2)}`)).toEqual(["CN-2627-00001 896.80"]);
    const returns = await getInvoiceReturns(as.sales_manager, (await getSalesDocument(as.sales_manager, first))!);
    expect(returns.creditNotes.map((note) => `${note.number} ${note.status} ${note.total.toFixed(2)}`)).toEqual(["CN-2627-00001 submitted 896.80"]);
    expect(returns.lines.map((l) => `${l.itemCode} ${l.left.toFixed()} of ${l.quantity.toFixed()}`)).toEqual(["HL-1 2 of 2", "CH-2 3 of 5", "BT-3 7 of 7"]);
    await booksAgree();
  });

  it("refuses to return more than was invoiced, and takes the last of a line to the paisa", async () => {
    const { id } = await startCreditNote(as.accountant, first);
    const chains = await lineOf(first, chain);
    await expect(saveCreditNoteDraft(as.accountant, id, { date: "2026-10-21", lines: [back(chains, "4")] })).rejects.toThrow("CH-2: the invoice billed 5 and 2 has already come back, so only 3 more can.");
    // Written past the app, a line for 4 of the 5 is a line of the invoice, and is refused when the credit note is posted.
    expect(await rawLine(as.accountant, id, chains, { quantity: "4", base_quantity: "4", value: "1520", tax_amount: "273.6", total: "1793.6", discount_amount: "80" })).toBeUndefined();
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`update sales_documents set gross_total = 1600, discount_total = 80, value_total = 1520, tax_total = 273.6, total = 1793.6, updated_by = ${userIds.accountant}::uuid where id = ${id}::uuid`));
    expect(await codeOf(as.accountant, sql`select * from app.post_credit_note(${id}::uuid)`)).toBe("SE114");
    // More than the invoice line itself is not even a line.
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`delete from sales_lines where document_id = ${id}::uuid`));
    expect(await rawLine(as.accountant, id, chains, { quantity: "6", base_quantity: "6" })).toBe("SE120");

    // The three that are left, all fit to sell: the credit notes of the line come to exactly what it billed.
    await saveCreditNoteDraft(as.accountant, id, { date: "2026-10-21", lines: [back(chains, "3")] });
    expect((await getSalesDocument(as.accountant, id))!.lines.map(figures)).toEqual(["CH-2 3 (0 damaged): 1140.00 + 205.20 + 0.00 = 1345.20"]);
    expect((await postCreditNote(as.accountant, id)).number).toBe("CN-2627-00002");
    expect(await journalOf("credit_note", id)).toEqual([
      "4100 Sales: 1140 / 0",
      "2200 Sales tax payable (output tax): 205.2 / 0",
      "1200 Trade receivables: 0 / 1345.2 (Registered Dealer)",
      "1300 Stock in trade: 810 / 0",
      "5100 Cost of goods sold: 0 / 810",
    ]);
    expect(await stock(chain)).toBe("16 worth 4320");
    expect(await open(dealer)).toEqual(["SI-2627-00001 2438.55 of 4680.55"]);
    // Nothing of the chains is left to return.
    const again = await startCreditNote(as.accountant, first);
    await expect(saveCreditNoteDraft(as.accountant, again.id, { date: "2026-10-21", lines: [back(chains, "1")] })).rejects.toThrow("so only 0 more can");
    await discardSalesDraft(as.accountant, again.id);
    await booksAgree();
  });

  it("works a line's share out to the paisa, and refuses figures that another credit note has overtaken", async () => {
    // Seven bolts were billed at 66.57 and 11.98 of tax, and cost 35.04. They come back 2, 2 and 3: each credit note brings
    // what has been taken back up to the exact share so far. The tax is 3.42, then 3.43 (four sevenths are 6.85), then 5.13.
    const bolts = await lineOf(first, bolt);
    const second2 = await anotherDraft(as.accountant, first, "2026-10-22");
    await saveCreditNoteDraft(as.accountant, second2, { date: "2026-10-22", lines: [back(bolts, "2")] });
    // Saved while nothing had come back: two sevenths, 3.42 of tax.
    expect((await getSalesDocument(as.accountant, second2))!.lines.map(figures)).toEqual(["BT-3 2 (0 damaged): 19.02 + 3.42 + 0.00 = 22.44"]);
    const first2 = await anotherDraft(as.accountant, first, "2026-10-22");
    await saveCreditNoteDraft(as.accountant, first2, { date: "2026-10-22", lines: [back(bolts, "2")] });
    expect((await postCreditNote(as.accountant, first2)).number).toBe("CN-2627-00003");
    // The other two now bring the line up to four sevenths, which is 3.43 more: the draft's 3.42 is no longer right, and neither the app nor the database posts it.
    await expect(postCreditNote(as.accountant, second2)).rejects.toThrow("Another credit note for this invoice was posted after this one was saved. Check it and save it again.");
    expect(await codeOf(as.accountant, sql`select * from app.post_credit_note(${second2}::uuid)`)).toBe("SE115");
    await saveCreditNoteDraft(as.accountant, second2, { date: "2026-10-22", lines: [back(bolts, "2")] });
    expect((await getSalesDocument(as.accountant, second2))!.lines.map(figures)).toEqual(["BT-3 2 (0 damaged): 19.02 + 3.43 + 0.00 = 22.45"]);
    expect((await postCreditNote(as.accountant, second2)).number).toBe("CN-2627-00004");
    const last3 = await anotherDraft(as.accountant, first, "2026-10-22");
    await saveCreditNoteDraft(as.accountant, last3, { date: "2026-10-22", lines: [back(bolts, "3")] });
    expect((await getSalesDocument(as.accountant, last3))!.lines.map(figures)).toEqual(["BT-3 3 (0 damaged): 28.53 + 5.13 + 0.00 = 33.66"]);
    await postCreditNote(as.accountant, last3);
    const [credited] = await admin`
      select sum(l.value)::text as value, sum(l.tax_amount)::text as tax, sum(l.quantity)::text as quantity, sum(c.cost)::text as cost,
             string_agg(trim_scale(c.cost)::text, ' ' order by d.number) as costs
      from public.sales_lines l join public.sales_documents d on d.id = l.document_id join public.credit_note_line_costs c on c.line_id = l.id
      where l.source_line_id = ${bolts} and d.kind = 'credit_note' and d.status = 'submitted'`;
    // Exactly what the line billed, and exactly what its goods cost: 10.01, then up to 20.02, then all 35.04.
    expect(credited).toEqual({ value: "66.5700", tax: "11.9800", quantity: "7.0000", cost: "35.0400", costs: "10.01 10.01 15.02" });
    // All twenty bolts are on the shelf again, worth what they were.
    expect(await stock(bolt)).toBe("20 worth 100.1");
    // What goods cost is read by those who read cost elsewhere, not by the sales team, whose credit notes these are.
    const costs = (who: TenantContext) => withTenant(who.userId, tenantA, (tx) => tx.execute(sql`select 1 from credit_note_line_costs`)).then((rows) => rows.length);
    for (const role of ["owner", "accountant", "auditor"] as const) expect(await costs(as[role]), role).toBeGreaterThan(0);
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) expect(await costs(as[role]), role).toBe(0);
    expect(await codeOf(as.owner, sql`update credit_note_line_costs set cost = 0`)).toBe("42501");
    expect(await codeOf(as.owner, sql`delete from credit_note_line_costs`)).toBe("42501");
    expect(await open(dealer)).toEqual(["SI-2627-00001 2360.00 of 4680.55"]);
    await booksAgree();

    // The app and the database work a share out to the same digit, whatever the figures.
    const random = (digits: number, scale: number) => new Decimal(Math.floor(Math.random() * 10 ** digits) + 1).div(10 ** scale);
    for (let i = 0; i < 150; i += 1) {
      const of = random(6, i % 3 === 0 ? 4 : 0);
      const quantity = Decimal.max(of.times(Math.random()).toDecimalPlaces(i % 3 === 0 ? 4 : 0, Decimal.ROUND_DOWN), new Decimal(i % 3 === 0 ? "0.0001" : "1"));
      const whole = random(9, i % 2 === 0 ? 2 : 4);
      const gone = whole.times(Math.random() * 0.6).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      const upto = i % 7 === 0 ? of : quantity;
      const [row] = await admin`select app.credit_note_share(${whole.toFixed(4)}::numeric, ${gone.toFixed(4)}::numeric, ${upto.toFixed(4)}::numeric, ${of.toFixed(4)}::numeric)::text as share`;
      expect(creditShare(whole, gone, upto, of).toFixed(4), `${whole} x ${upto} / ${of}, ${gone} gone`).toBe(new Decimal(row.share).toFixed(4));
    }
  });

  it("leaves a return on a paid invoice as the customer's credit, which the owner or an accountant sets against another invoice", async () => {
    // 14 October: Walk-in Rider pays the whole of SI-2627-00002 in cash.
    const receipt = await saveReceiptDraft(as.recovery_officer, null, { date: "2026-10-14", customerId: rider, method: "cash", accountId: cash, amount: "2684", allocations: [{ kind: "invoice", id: second, amount: "2684" }] });
    await postReceipt(as.recovery_officer, receipt.id);
    expect(await open(rider)).toEqual(["OLD-9 500.00 of 500.00"]);

    // 18 October: the helmet comes back, fit to sell. Nothing is left to pay on the invoice, so the whole 1,220 is the customer's credit.
    const { id } = await startCreditNote(as.owner, second);
    await saveCreditNoteDraft(as.owner, id, { date: "2026-10-18", lines: [back(await lineOf(second, helmet), "1")] });
    expect((await getSalesDocument(as.owner, id))!.lines.map(figures)).toEqual(["HL-1 1 (0 damaged): 1000.00 + 180.00 + 40.00 = 1220.00"]);
    const posted = await postCreditNote(as.owner, id);
    expect(`${posted.setAgainstInvoice.toFixed(2)} ${posted.leftAsCredit.toFixed(2)}`).toBe("0.00 1220.00");
    expect(await journalOf("credit_note", id)).toEqual([
      "4100 Sales: 1000 / 0",
      "2200 Sales tax payable (output tax): 180 / 0",
      "2205 Further tax payable: 40 / 0",
      "2130 Advances from customers: 0 / 1220 (Walk-in Rider)",
      "1300 Stock in trade: 600 / 0",
      "5100 Cost of goods sold: 0 / 600",
    ]);
    expect(await balance("customer_advances", rider)).toBe("-1220.00");
    expect(await balance("ar", rider)).toBe("500.00");

    // 19 October: the rider buys 2 chains, 976 with tax. On the 20th, 976 of the credit is set against that invoice.
    const third = await invoice(await order(rider, "2026-10-19", [line(chain, "2")]), "2026-10-19");
    expect(await open(rider)).toEqual(["OLD-9 500.00 of 500.00", "SI-2627-00003 976.00 of 976.00"]);
    const pay = (invoiceId: string, amount: string) => [{ kind: "invoice", id: invoiceId, amount }];
    await expect(applyCredit(as.sales_manager, id, { date: "2026-10-20", allocations: pay(third, "976") })).rejects.toThrow("Only an owner or an accountant can set a customer's credit against invoices.");
    expect(await codeOf(as.sales_manager, sql`select app.apply_credit_note(${id}::uuid, '2026-10-20', ${JSON.stringify([{ invoice_id: third, amount: "976" }])}::jsonb)`)).toBe("42501");
    await expect(applyCredit(as.accountant, id, { date: "2026-10-17", allocations: pay(third, "976") })).rejects.toThrow("on or after the day of its credit note");
    await expect(applyCredit(as.accountant, id, { date: "2026-10-18", allocations: pay(third, "976") })).rejects.toThrow("SI-2627-00003 is dated after that day");
    await expect(applyCredit(as.accountant, id, { date: "2026-10-20", allocations: pay(third, "976.01") })).rejects.toThrow("SI-2627-00003 has 976.00 left to pay, not 976.01.");
    await expect(applyCredit(as.accountant, id, { date: "2026-10-20", allocations: pay(first, "100") })).rejects.toThrow("not an unpaid invoice of this customer");
    expect(await codeOf(as.accountant, sql`select app.apply_credit_note(${id}::uuid, '2026-10-20', ${JSON.stringify([{ invoice_id: first, amount: "100" }])}::jsonb)`)).toBe("SE102");
    expect(await applyCredit(as.accountant, id, { date: "2026-10-20", allocations: pay(third, "976") })).toEqual({ invoices: 1 });
    expect(await open(rider)).toEqual(["OLD-9 500.00 of 500.00"]);
    expect(await balance("customer_advances", rider)).toBe("-244.00");
    expect(await balance("ar", rider)).toBe("500.00");
    const [applied] = await admin<{ id: string }[]>`select id from public.credit_note_allocations where credit_note_id = ${id} and invoice_id = ${third}`;
    expect(await journalOf("credit_application", applied.id)).toEqual(["2130 Advances from customers: 976 / 0 (Walk-in Rider)", "1200 Trade receivables: 0 / 976 (Walk-in Rider)"]);
    const facts = await getCreditNoteFacts(as.accountant, (await getSalesDocument(as.accountant, id))!);
    expect(facts.settled.map((row) => `${row.number} ${row.amount.toFixed(2)} ${row.allocatedOn} ${row.later}`)).toEqual(["SI-2627-00003 976.00 2026-10-20 true"]);
    expect(facts.left.toFixed(2)).toBe("244.00");
    // No more than is left of it.
    const fourth = await invoice(await order(rider, "2026-10-21", [line(chain, "1")]), "2026-10-21");
    await expect(applyCredit(as.accountant, id, { date: "2026-10-21", allocations: pay(fourth, "300") })).rejects.toThrow("This credit note has 244.00 not yet set against an invoice.");
    expect(await codeOf(as.accountant, sql`select app.apply_credit_note(${id}::uuid, '2026-10-21', ${JSON.stringify([{ invoice_id: fourth, amount: "300" }])}::jsonb)`)).toBe("SE118");
    await booksAgree();
  });

  it("settles what is still unpaid of a part-paid invoice and leaves the rest as credit; damaged goods never reach the shelf", async () => {
    // Registered Dealer still owes 2,360 on SI-2627-00001 (the two helmets), and pays 2,000 of it.
    const receipt = await saveReceiptDraft(as.accountant, null, { date: "2026-10-23", customerId: dealer, method: "cash", accountId: cash, amount: "2000", allocations: [{ kind: "invoice", id: first, amount: "2000" }] });
    await postReceipt(as.accountant, receipt.id);
    expect(await open(dealer)).toEqual(["SI-2627-00001 360.00 of 4680.55"]);
    // 24 October: one helmet comes back cracked. 360 settles the invoice; 820 is the dealer's credit.
    const { id } = await startCreditNote(as.accountant, first);
    await saveCreditNoteDraft(as.accountant, id, { date: "2026-10-24", lines: [back(await lineOf(first, helmet), "1", "1")] });
    const before = await stock(helmet);
    const posted = await postCreditNote(as.accountant, id);
    expect(`${posted.setAgainstInvoice.toFixed(2)} ${posted.leftAsCredit.toFixed(2)}`).toBe("360.00 820.00");
    expect(await journalOf("credit_note", id)).toEqual([
      "4100 Sales: 1000 / 0",
      "2200 Sales tax payable (output tax): 180 / 0",
      "1200 Trade receivables: 0 / 360 (Registered Dealer)",
      "2130 Advances from customers: 0 / 820 (Registered Dealer)",
      "5110 Stock adjustments: 600 / 0",
      "5100 Cost of goods sold: 0 / 600",
    ]);
    expect(await stock(helmet)).toBe(before);
    expect((await admin`select count(*)::int as n from public.stock_moves where source_id = ${id}`)[0].n).toBe(0);
    expect((await admin`select trim_scale(cost)::text || ' ' || trim_scale(written_off)::text as c from public.credit_note_line_costs where credit_note_id = ${id}`).map((row) => row.c)).toEqual(["600 600"]);
    expect(await open(dealer)).toEqual([]);
    expect(await balance("customer_advances", dealer)).toBe("-820.00");
    await booksAgree();
  });

  it("reaches the books only through the database's own posting function, as the invoice billed it", async () => {
    const helmets = await lineOf(first, helmet);
    const id = await anotherDraft(as.accountant, first, "2026-10-25");
    const total = (figure: string) => sql`update sales_documents set gross_total = 1000, value_total = ${figure}::numeric, tax_total = 180, total = ${figure}::numeric + 180, updated_by = ${userIds.accountant}::uuid where id = ${id}::uuid`;
    const clear = () => withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`delete from sales_lines where document_id = ${id}::uuid`));
    // A line is its invoice line in everything but how much: not another price, not another invoice's line, not without saying what is damaged.
    expect(await rawLine(as.accountant, id, helmets, { quantity: "1", base_quantity: "1", unit_price: "1200" })).toBe("SE120");
    expect(await rawLine(as.accountant, id, helmets, { quantity: "1", base_quantity: "1", tax_rate: "10" })).toBe("SE120");
    expect(await rawLine(as.accountant, id, await lineOf(second, helmet), { quantity: "1", base_quantity: "1" })).toBe("SE120");
    expect(await rawLine(as.accountant, id, helmets, { quantity: "1", base_quantity: "1", damaged_quantity: null })).toBe("SE120");
    // And only a credit note's lines say what is damaged, or lack salespeople of their own.
    const anOrder = await saveSalesDraft(as.salesperson, null, { kind: "order", date: "2026-10-25", customerId: dealer, warehouseId: warehouse, lines: [line(helmet, "1")], shares: [] });
    const [orderLine] = await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${anOrder.id}`;
    expect(await rawLine(as.salesperson, anOrder.id, orderLine.id, { line_no: "2", source_line_id: null, damaged_quantity: "1" })).toBe("SE120");
    await discardSalesDraft(as.salesperson, anOrder.id);
    // Figures that are not the invoice's (a helmet credited at 1,500, not the 1,000 it was billed at) are refused when it is posted.
    expect(await rawLine(as.accountant, id, helmets, { quantity: "1", base_quantity: "1", value: "1500", tax_amount: "180", total: "1680" })).toBeUndefined();
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(total("1500")));
    expect(await codeOf(as.accountant, sql`select * from app.post_credit_note(${id}::uuid)`)).toBe("SE115");
    await clear();
    // The right figures, marked submitted by hand: only the posting function can write the mark that says it posted it.
    expect(await rawLine(as.accountant, id, helmets, { quantity: "1", base_quantity: "1", value: "1000", tax_amount: "180", total: "1180" })).toBeUndefined();
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(total("1000")));
    expect(await codeOf(as.accountant, sql`update sales_documents set status = 'submitted', submitted_by = ${userIds.accountant}::uuid, updated_by = ${userIds.accountant}::uuid where id = ${id}::uuid`)).toBe("SE117");
    expect(await codeOf(as.accountant, sql`update sales_documents set status = 'submitted', submitted_by = ${userIds.accountant}::uuid, updated_by = ${userIds.accountant}::uuid, posted_txid = txid_current() where id = ${id}::uuid`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`insert into sales_line_salespeople (tenant_id, document_id, line_id, user_id, share_percent, created_by) select tenant_id, document_id, id, ${userIds.salesperson}::uuid, 100, ${userIds.accountant}::uuid from sales_lines where document_id = ${id}::uuid`)).toBe("SE120");
    // Nor can the app's role write what a credit note settled, or a journal for one.
    expect(await codeOf(as.accountant, sql`insert into credit_note_allocations (tenant_id, credit_note_id, invoice_id, amount, allocated_on, journal_id, created_by) values (${tenantA}::uuid, ${id}::uuid, ${first}::uuid, 5, '2026-10-25', gen_random_uuid(), ${userIds.accountant}::uuid)`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`delete from credit_note_allocations where tenant_id = ${tenantA}::uuid`)).toBe("42501");
    // Not before it happens, and not before its invoice.
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`update sales_documents set document_date = '2027-01-05', updated_by = ${userIds.accountant}::uuid where id = ${id}::uuid`));
    await expect(postCreditNote(as.accountant, id)).rejects.toThrow("That date has not come yet.");
    expect(await codeOf(as.accountant, sql`select * from app.post_credit_note(${id}::uuid)`)).toBe("SE111");
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`update sales_documents set document_date = '2026-10-11', updated_by = ${userIds.accountant}::uuid where id = ${id}::uuid`));
    expect(await codeOf(as.accountant, sql`select * from app.post_credit_note(${id}::uuid)`)).toBe("SE113");
    await discardSalesDraft(as.accountant, id);

    // A posted credit note is never changed, cancelled or removed.
    const [posted] = await admin<{ id: string }[]>`select id from public.sales_documents where tenant_id = ${tenantA} and number = 'CN-2627-00001'`;
    await expect(cancelSalesDocument(as.owner, posted.id, { reason: "Entered by mistake" })).rejects.toThrow("A posted credit note is not cancelled.");
    expect(await codeOf(as.owner, sql`update sales_documents set status = 'cancelled', cancelled_by = ${userIds.owner}::uuid, cancel_reason = 'Entered by mistake', updated_by = ${userIds.owner}::uuid where id = ${posted.id}::uuid`)).toBe("SE116");
    expect(await codeOf(as.owner, sql`update sales_documents set notes = 'changed', updated_by = ${userIds.owner}::uuid where id = ${posted.id}::uuid`)).toBe("SE050");
    expect(await codeOf(as.owner, sql`delete from sales_lines where document_id = ${posted.id}::uuid`)).toBe("SE050");
    expect(await codeOf(as.owner, sql`select * from app.post_credit_note(${posted.id}::uuid)`)).toBe("SE050");
    // Another company's owner finds nothing to post or to use.
    expect(await codeOf(otherOwner, sql`select * from app.post_credit_note(${posted.id}::uuid)`)).toBe("SE112");
    expect(await codeOf(otherOwner, sql`select app.apply_credit_note(${posted.id}::uuid, '2026-10-25', '[{"invoice_id": "00000000-0000-0000-0000-000000000000", "amount": "1"}]'::jsonb)`)).toBe("SE112");
    expect((await withTenant(ownerB, tenantB, (tx) => tx.execute(sql`select * from app.credit_note_settled(${posted.id}::uuid)`))).length).toBe(0);
    await booksAgree();
  });

  it("sets credit against an invoice from before the books were opened, and those opening balances then stay", async () => {
    const [old] = await admin<{ id: string }[]>`select b.id from public.opening_balances b where b.tenant_id = ${tenantA} and b.document_number = 'OLD-9'`;
    const [note] = await admin<{ id: string; number: string }[]>`select id, number from public.sales_documents where tenant_id = ${tenantA} and kind = 'credit_note' and customer_id = ${rider} and status = 'submitted'`;
    expect(await applyCredit(as.accountant, note.id, { date: "2026-10-25", allocations: [{ kind: "opening", id: old.id, amount: "100" }] })).toEqual({ invoices: 1 });
    expect((await open(rider))[0]).toBe("OLD-9 400.00 of 500.00");
    expect(await balance("customer_advances", rider)).toBe("-144.00");
    // The owner reads which old invoice it was; a salesperson, who does not read the opening balances, sees the amount and the day.
    const document = (await getSalesDocument(as.owner, note.id))!;
    const row = (who: TenantContext) => getCreditNoteFacts(who, document).then((facts) => facts.settled.filter((r) => r.kind === "opening").map((r) => `${r.number} ${r.targetId === null ? "hidden" : "shown"} ${r.amount.toFixed(2)} ${r.allocatedOn}`));
    expect(await row(as.owner)).toEqual(["OLD-9 shown 100.00 2026-10-25"]);
    expect(await row(as.salesperson)).toEqual(["null hidden 100.00 2026-10-25"]);
    // Nor does a salesperson read the rows themselves, or learn of an invoice that is not theirs.
    expect((await withTenant(as.salesperson.userId, tenantA, (tx) => tx.execute(sql`select 1 from credit_note_allocations`))).length).toBe(0);
    expect((await withTenant(as.sales_manager.userId, tenantA, (tx) => tx.execute(sql`select 1 from credit_note_allocations`))).length).toBeGreaterThan(0);

    // Reversing the opening balances would leave the credit settling an invoice that is no longer in the books.
    const refused = await reverseOpening(as.owner).then(
      () => "reversed",
      (error: { code?: string; cause?: { code?: string } }) => error.cause?.code ?? error.code,
    );
    expect(refused).toBe("SE119");
    // Nor from a transaction that reads an older picture of the database, in which the credit might not be seen.
    const [entry] = await admin<{ id: string; journal_id: string }[]>`select id, journal_id from public.opening_entries where tenant_id = ${tenantA} and status = 'posted'`;
    const direct = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const stale = await direct
        .begin("isolation level repeatable read", async (tx) => {
          await enterAs(tx, userIds.owner, tenantA);
          const [reversal] = await tx`select app.reverse_journal(${entry.journal_id}::uuid, '2026-10-01'::date, 'Reversal of the opening balances') as id`;
          await tx`update public.opening_entries set status = 'reversed', reversal_journal_id = ${reversal.id}, reversed_at = now(), reversed_by = ${userIds.owner}, updated_at = now(), updated_by = ${userIds.owner} where id = ${entry.id}`;
        })
        .then(
          () => "reversed",
          (error: { code?: string }) => error.code,
        );
      // Since the security clean-up nobody is anybody in a transaction that keeps an old picture:
      // it is refused when it says who it is, before it reaches the guard (SE056) behind that.
      expect(stale).toBe("42501");
    } finally {
      await direct.end();
    }
    expect((await admin`select status from public.opening_entries where tenant_id = ${tenantA}`)[0].status).toBe("posted");
    await booksAgree();
  });

  it("takes goods back in the unit they were sold in, whatever has become of the item's units since", async () => {
    // A carton of 12 chains is sold; afterwards a carton is made to hold 10, and then is no longer a unit of the item at all.
    const carton = (await addUnit(as.owner, { code: "ctn", name: "Carton" })).id;
    await setItemUnit(as.owner, chain, { unit: carton, factor: "12" });
    const sold = await invoice(await order(dealer, "2026-10-28", [line(chain, "1", "", carton)]), "2026-10-28");
    const before = await stock(chain);
    await setItemUnit(as.owner, chain, { unit: carton, factor: "10" });
    const { id } = await startCreditNote(as.accountant, sold);
    const cartons = await lineOf(sold, chain);
    await saveCreditNoteDraft(as.accountant, id, { date: "2026-10-28", lines: [back(cartons, "0.5")] });
    await removeItemUnit(as.owner, chain, carton);
    await postCreditNote(as.accountant, id);
    // Half the carton that left: six chains, at half of what the twelve cost.
    const [move] = await admin`select quantity::text, value::text from public.stock_moves where source_id = ${id}`;
    const [out] = await admin`select value::text from public.stock_moves where source_id = ${sold}`;
    expect(move.quantity).toBe("6.0000");
    expect(new Decimal(move.value).toFixed(2)).toBe(new Decimal(out.value).neg().div(2).toFixed(2));
    expect(await stock(chain)).toBe(`${Number(before.split(" ")[0]) + 6} worth ${new Decimal(before.split(" ")[2]).plus(move.value).toNumber()}`);
    await booksAgree();
  });

  it("lets only one of two credit notes for the same goods through, and takes goods back from a customer archived since", async () => {
    // The last helmet of SI-2627-00001 on two drafts at once: whichever posts second finds nothing left.
    const helmets = await lineOf(first, helmet);
    const drafts = [await anotherDraft(as.accountant, first, "2026-10-26"), await anotherDraft(as.owner, first, "2026-10-26")];
    await saveCreditNoteDraft(as.accountant, drafts[0], { date: "2026-10-26", lines: [back(helmets, "1")] });
    await saveCreditNoteDraft(as.owner, drafts[1], { date: "2026-10-26", lines: [back(helmets, "1")] });
    const outcomes = await Promise.allSettled([
      withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`select * from app.post_credit_note(${drafts[0]}::uuid)`)),
      withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`select * from app.post_credit_note(${drafts[1]}::uuid)`)),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = drafts[outcomes.findIndex((outcome) => outcome.status === "rejected")];
    await expect(postCreditNote(as.owner, lost)).rejects.toThrow("HL-1: the invoice billed 2 and 2 has already come back, so only 0 more can.");
    await discardSalesDraft(as.owner, lost);
    // Everything on the invoice has now come back.
    await expect(startCreditNote(as.owner, first)).rejects.toThrow("Everything on this invoice has already been returned.");
    const [credited] = await admin`select sum(d.total)::text as total from public.sales_documents d where d.source_document_id = ${first} and d.kind = 'credit_note' and d.status = 'submitted'`;
    expect(credited.total).toBe("4680.5500");

    // Walk-in Rider is archived; the chains of SI-2627-00002 still come back.
    await setPartyArchived(as.owner, "customer", rider, true);
    const { id } = await startCreditNote(as.sales_manager, second);
    await saveCreditNoteDraft(as.sales_manager, id, { date: "2026-10-27", lines: [back(await lineOf(second, chain), "1", "1")] });
    expect((await postCreditNote(as.sales_manager, id)).leftAsCredit.toFixed(2)).toBe("488.00");
    await setPartyArchived(as.owner, "customer", rider, false);
    await booksAgree();
  });
});
