import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { getDocumentJournal } from "@/modules/ledger/queries";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import { createParty, setPartyArchived } from "@/modules/parties/commands";
import { setItemArchived } from "@/modules/items/commands";
import { getTrialBalance } from "@/modules/reports/queries";
import { setTaxRate } from "@/modules/tax/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { cancelDelivery, cancelSalesDocument, discardSalesDraft, postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "./commands";
import { getCustomerCredit, getOrderDelivery, getSalesDocument, listInvoicesOf, listOrdersToDeliver, listSalesDocuments } from "./queries";
import { salesDocuments, salesLineSalespeople, salesLines } from "./schema";

// Sales invoices against a real database, through the app's own path: the worked example of
// docs/examples/step-20.md (a registered buyer invoiced from a delivery note, an unregistered
// one invoiced straight from an order), and what is refused. Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-invoice-test";
const tenantR = randomUUID(); // Lahore Bike Parts: registered for sales tax, prices before tax
const tenantU = randomUUID(); // a company not registered for sales tax
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const seller2 = randomUUID();
const ownerU = randomUUID();
const branchR = randomUUID();
const warehouseR = randomUUID();
const warehouseU = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@invoice.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantR, role)])) as Record<(typeof roles)[number], TenantContext>;
const second = ctx(seller2, tenantR, "salesperson");
const plain = ctx(ownerU, tenantU, "owner");

let admin: AdminSql;
let helmet: string; // 10 that cost 600 each
let chain: string; // 12 at 250 and 8 at 300: 270 each
let dealer: string; // registered and active, 30 days of credit
let rider: string; // not registered: further tax applies

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const line = (itemId: string, quantity: string, extra: { unitPrice?: string; discountPercent?: string } = {}) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "", ...extra });
async function order(who: TenantContext, customerId: string, date: string, lines: ReturnType<typeof line>[], warehouseId = warehouseR, shares: { userId: string; percent: string }[] = []): Promise<string> {
  const { id } = await saveSalesDraft(who, null, { kind: "order", date, customerId, warehouseId, lines, shares });
  await submitSalesDocument(who, id);
  return id;
}
/** A posted delivery note for everything the order still has to deliver, dated as given. */
async function deliver(who: TenantContext, orderId: string, date: string): Promise<string> {
  const { id } = await startDelivery(who, orderId);
  const note = (await getSalesDocument(who, id))!;
  await saveDeliveryDraft(who, id, { date, lines: note.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postDelivery(who, id);
  return id;
}
/** A draft invoice dated as given, keeping its lines. */
async function invoice(who: TenantContext, sourceId: string, date: string, quantities?: string[]): Promise<string> {
  const { id } = await startInvoice(who, sourceId);
  const draft = (await getSalesDocument(who, id))!;
  await saveInvoiceDraft(who, id, { date, lines: draft.lines.map((l, index) => ({ sourceLineId: l.sourceLineId, quantity: quantities?.[index] ?? l.quantity.toFixed() })) });
  return id;
}
const journalOf = async (sourceType: string, sourceId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ' | ' || l.debit::text || ' | ' || l.credit::text || coalesce(' | ' || c.name, '') as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      left join public.customers c on c.id = l.customer_id
      where j.source_type = ${sourceType} and j.source_id = ${sourceId} order by l.line_no`
  ).map((row) => row.line);
const stock = async (itemId: string) => {
  const [row] = await admin`select quantity::text, value::text from public.stock_balances where item_id = ${itemId}`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};
const figures = (l: { itemCode: string; quantity: { toFixed(): string }; value: { toFixed(n: number): string }; taxAmount: { toFixed(n: number): string }; furtherTaxAmount: { toFixed(n: number): string }; total: { toFixed(n: number): string } }) =>
  `${l.itemCode} ${l.quantity.toFixed()}: ${l.value.toFixed(2)} + ${l.taxAmount.toFixed(2)} + ${l.furtherTaxAmount.toFixed(2)} = ${l.total.toFixed(2)}`;
const balances = async (tenantId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ' ' || sum(l.debit - l.credit)::text as line
      from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantId} group by a.code, a.name order by a.code`
  ).map((row) => row.line);

describe.skipIf(!hasDb)("sales invoices", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantR}, ${PREFIX + " R"}, ${userIds.owner}), (${tenantU}, ${PREFIX + " U"}, ${ownerU})`;
    const branchU = randomUUID();
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branchR}, ${tenantR}, 'Main', ${userIds.owner}), (${branchU}, ${tenantU}, 'Main', ${ownerU})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouseR}, ${tenantR}, ${branchR}, 'Main store', ${userIds.owner}), (${warehouseU}, ${tenantU}, ${branchU}, 'Main store', ${ownerU})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantR, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantR, user_id: seller2, email: second.email, role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantU, user_id: ownerU, email: plain.email, role: "owner", branch_ids: null, created_by: ownerU },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantR}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantU}, false, 'trading', ${ownerU})`;
    await admin`select app.seed_tax_defaults(${tenantR}, ${userIds.owner})`;
    for (const owner of [as.owner, plain]) {
      await setBaseCurrency(owner, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(owner, "trading");
      await openFiscalYear(owner, { month: "7", year: "2026" });
    }
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    chain = (await createItem(as.owner, { code: "CH-2", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Registered Dealer", code: "C-001", registrationType: "registered", ntn: "1234567", strn: "3277876123456", atlStatus: "active", creditDays: "30", creditLimit: "100000" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Walk-in Rider", code: "C-002" })).id;
    const seed = { tenantId: tenantR, warehouseId: warehouseR, userId: userIds.owner };
    await seedStock(admin, { ...seed, itemId: helmet, quantity: "10", value: "6000" });
    await seedStock(admin, { ...seed, itemId: chain, quantity: "12", value: "3000" });
    await seedStock(admin, { ...seed, itemId: chain, quantity: "8", value: "2400" });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantR, tenantU]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("posts the worked example: a registered buyer from a delivery note, an unregistered one straight from an order", async () => {
    // 10 November: 2 helmets and 5 chains (5% off the chains) are delivered to Registered Dealer.
    const order1 = await order(as.salesperson, dealer, "2026-11-10", [line(helmet, "2"), line(chain, "5", { discountPercent: "5" })], warehouseR, [{ userId: userIds.salesperson, percent: "100" }]);
    const note = await deliver(as.warehouse_manager, order1, "2026-11-10");
    expect(await journalOf("delivery_note", note)).toEqual(["5100 Cost of goods sold | 2550.0000 | 0.0000", "1300 Stock in trade | 0.0000 | 2550.0000"]);

    // 12 November: invoice no. 1 bills exactly what was delivered. No further tax: the buyer is registered and active.
    for (const who of [as.warehouse_manager, as.auditor]) await expect(startInvoice(who, note), who.role).rejects.toThrow("Your role cannot write sales documents.");
    await expect(startInvoice(second, note)).rejects.toThrow("A sales invoice is made from a sales order or a delivery note.");
    const first = await invoice(as.salesperson, note, "2026-11-12");
    // Asking again opens the same draft, not a second one.
    expect((await startInvoice(as.salesperson, note)).id).toBe(first);
    const draft = await getSalesDocument(as.salesperson, first);
    expect(draft).toMatchObject({ kind: "invoice", status: "draft", number: null, date: "2026-11-12", taxed: true, pricesIncludeTax: false, source: { id: note, kind: "delivery", number: "DN-2627-00001" }, dueDate: null });
    expect(draft!.lines.map(figures)).toEqual(["HL-1 2: 2000.00 + 360.00 + 0.00 = 2360.00", "CH-2 5: 1900.00 + 342.00 + 0.00 = 2242.00"]);
    expect(`${draft!.totals.value.toFixed(2)} ${draft!.totals.tax.toFixed(2)} ${draft!.totals.furtherTax.toFixed(2)} ${draft!.totals.total.toFixed(2)}`).toBe("3900.00 702.00 0.00 4602.00");
    // The invoice carries the order's salespeople, line by line.
    expect(draft!.shares.map((s) => `${s.userId === userIds.salesperson} ${s.percent.toFixed()}`)).toEqual(["true 100"]);
    expect(await journalOf("sales_invoice", first)).toEqual([]);

    expect(await postInvoice(as.salesperson, first)).toEqual({ number: "SI-2627-00001", dueDate: "2026-12-12" });
    expect(await journalOf("sales_invoice", first)).toEqual([
      "1200 Trade receivables | 4602.0000 | 0.0000 | Registered Dealer",
      "4100 Sales | 0.0000 | 3900.0000",
      "2200 Sales tax payable (output tax) | 0.0000 | 702.0000",
    ]);
    const posted = await getSalesDocument(as.auditor, first);
    expect(posted).toMatchObject({ status: "submitted", number: "SI-2627-00001", customerName: "Registered Dealer", dueDate: "2026-12-12" });
    const [stored] = await admin`select buyer_ntn, buyer_strn, buyer_registration_type, buyer_atl_status, buyer_address, submitted_by, fbr_status, fbr_invoice_number from public.sales_documents where id = ${first}`;
    expect(stored).toEqual({ buyer_ntn: "1234567", buyer_strn: "3277876123456", buyer_registration_type: "registered", buyer_atl_status: "active", buyer_address: null, submitted_by: userIds.salesperson, fbr_status: null, fbr_invoice_number: null });
    // Nothing left stock with the invoice: the delivery note had taken it.
    expect((await admin`select count(*)::int as n from public.stock_moves where source_id = ${first}`)[0].n).toBe(0);
    expect(await stock(helmet)).toBe("8 worth 4800");

    // 13 November: invoice no. 2 goes straight from an order to Walk-in Rider, who is not registered: 4% further tax, and the goods leave with the invoice.
    const order2 = await order(as.salesperson, rider, "2026-11-13", [line(helmet, "1"), line(chain, "3")]);
    const direct = await invoice(as.salesperson, order2, "2026-11-13");
    expect((await getSalesDocument(as.salesperson, direct))!.lines.map(figures)).toEqual(["HL-1 1: 1000.00 + 180.00 + 40.00 = 1220.00", "CH-2 3: 1200.00 + 216.00 + 48.00 = 1464.00"]);
    expect(await postInvoice(as.salesperson, direct)).toEqual({ number: "SI-2627-00002", dueDate: "2026-11-13" });
    expect(await journalOf("sales_invoice", direct)).toEqual([
      "1200 Trade receivables | 2684.0000 | 0.0000 | Walk-in Rider",
      "4100 Sales | 0.0000 | 2200.0000",
      "2200 Sales tax payable (output tax) | 0.0000 | 396.0000",
      "2205 Further tax payable | 0.0000 | 88.0000",
      "5100 Cost of goods sold | 1410.0000 | 0.0000",
      "1300 Stock in trade | 0.0000 | 1410.0000",
    ]);
    expect(await stock(helmet)).toBe("7 worth 4200");
    expect(await stock(chain)).toBe("12 worth 3240");
    const moves = await admin`select i.code, m.quantity::text, m.value::text, m.source_type from public.stock_moves m join public.items i on i.id = m.item_id where m.source_id = ${direct} order by i.code`;
    expect(moves.map((m) => `${m.code} ${m.quantity} ${m.value} ${m.source_type}`)).toEqual(["CH-2 -3.0000 -810.0000 sales_invoice", "HL-1 -1.0000 -600.0000 sales_invoice"]);

    // The books after the three documents (stock was put in for the test without an entry, so its account shows only what left).
    expect(await balances(tenantR)).toEqual([
      "1200 Trade receivables 7286.0000",
      "1300 Stock in trade -3960.0000",
      "2200 Sales tax payable (output tax) -1098.0000",
      "2205 Further tax payable -88.0000",
      "4100 Sales -6100.0000",
      "5100 Cost of goods sold 3960.0000",
    ]);
    const trial = await getTrialBalance(as.accountant, { from: "2026-11-01", to: "2026-11-30", branchId: null, accountId: null });
    expect(JSON.stringify(trial)).toContain("Further tax payable");
    // The document's own page shows its journal to those who keep the books, and to nobody else.
    expect((await getDocumentJournal(as.accountant, "sales_invoice", direct))?.lines.map((l) => `${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["1200 2684.00 0.00", "4100 0.00 2200.00", "2200 0.00 396.00", "2205 0.00 88.00", "5100 1410.00 0.00", "1300 0.00 1410.00"]);
    expect(await getDocumentJournal(as.salesperson, "sales_invoice", direct)).toBeNull();
    // What the customers owe is in the receivable now, and no longer counted as open orders.
    const credit = await getCustomerCredit(as.owner, dealer);
    expect(`${credit!.receivable.toFixed(2)} ${credit!.openOrders.toFixed(2)}`).toBe("4602.00 0.00");
    expect((await getOrderDelivery(as.owner, order1))!.map((l) => `${l.itemCode} ${l.ordered.toFixed()} ${l.delivered.toFixed()} ${l.invoiced.toFixed()}`)).toEqual(["HL-1 2 2 2", "CH-2 5 5 5"]);
    expect((await getOrderDelivery(as.owner, order2))!.map((l) => `${l.itemCode} ${l.ordered.toFixed()} ${l.delivered.toFixed()} ${l.invoiced.toFixed()}`)).toEqual(["HL-1 1 1 1", "CH-2 3 3 3"]);
    expect(await listOrdersToDeliver(as.warehouse_manager)).toEqual([]);
    expect((await listInvoicesOf(as.owner, note)).map((i) => `${i.number} ${i.status}`)).toEqual(["SI-2627-00001 submitted"]);
    expect((await listSalesDocuments(as.accountant, { kind: "invoice" })).rows.map((r) => `${r.number} ${r.customerName} ${r.total.toFixed(2)}`)).toEqual(["SI-2627-00002 Walk-in Rider 2684.00", "SI-2627-00001 Registered Dealer 4602.00"]);
    await expect(listSalesDocuments(as.warehouse_manager, { kind: "invoice" })).rejects.toThrow("Your role does not include sales documents.");
    // The audit log has the posting and the journal, in the poster's name.
    const audit = await admin<{ action: string; actor_role: string }[]>`select action, actor_role from public.audit_log where entity_id = ${first} or (after->>'sourceId') = ${first} order by at, action`;
    expect(audit.map((a) => `${a.action} by ${a.actor_role}`)).toEqual(["sales_invoice.create by salesperson", "sales_invoice.update by salesperson", "journal.post by salesperson", "sales_invoice.submit by salesperson"]);

    // A posted invoice is never changed or cancelled; neither is the delivery note it billed, nor its order.
    const mine = and(eq(salesDocuments.tenantId, tenantR), eq(salesDocuments.id, first));
    await expect(saveInvoiceDraft(as.salesperson, first, { date: "2026-11-12", lines: [] })).rejects.toThrow("This invoice is posted and cannot be changed.");
    await expect(postInvoice(as.salesperson, first)).rejects.toThrow("This invoice is already posted.");
    await expect(discardSalesDraft(as.salesperson, first)).rejects.toThrow("Only a draft can be thrown away.");
    await expect(cancelSalesDocument(as.owner, first, { reason: "Wrong price" })).rejects.toThrow("A posted sales invoice is not cancelled. It is corrected by a credit note.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.update(salesDocuments).set({ status: "cancelled", cancelledBy: userIds.owner, cancelReason: "Wrong price", updatedBy: userIds.owner }).where(mine)))).toBe("SE072");
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.delete(salesLines).where(eq(salesLines.documentId, first))))).toBe("SE050");
    await expect(cancelDelivery(as.owner, note, { date: "2026-11-12", reason: "Wrong shop" })).rejects.toThrow("This delivery note has been invoiced (SI-2627-00001). It can no longer be cancelled.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.execute(sql`select app.cancel_delivery(${note}::uuid, '2026-11-12'::date, 'Wrong shop')`)))).toBe("SE073");
    await expect(cancelSalesDocument(as.owner, order1, { reason: "Changed their mind" })).rejects.toThrow("This order has been invoiced. It can no longer be cancelled.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.update(salesDocuments).set({ status: "cancelled", cancelledBy: userIds.owner, cancelReason: "Changed", updatedBy: userIds.owner }).where(eq(salesDocuments.id, order2))))).toBe("SE065");
    // A delivery note is invoiced once.
    await expect(startInvoice(as.salesperson, note)).rejects.toThrow("This delivery note has already been invoiced (SI-2627-00001).");
  });

  it("invoices part of an order, leaves the rest to be delivered, and never sells stock that is not there", async () => {
    // 7 helmets are left. An order for 6: 2 invoiced straight away, 4 left for the warehouse.
    const orderId = await order(as.sales_manager, dealer, "2026-11-14", [line(helmet, "6"), line(chain, "2")]);
    const part = await invoice(as.sales_manager, orderId, "2026-11-14", ["2", ""]);
    await expect(saveInvoiceDraft(as.sales_manager, part, { date: "2026-11-13", lines: [] })).rejects.toThrow("An invoice is dated on or after the order it was made from.");
    const lineIds = (await getSalesDocument(as.owner, orderId))!.lines.map((l) => l.id);
    await expect(saveInvoiceDraft(as.sales_manager, part, { date: "2026-11-14", lines: [{ sourceLineId: lineIds[0], quantity: "7" }] })).rejects.toThrow("HL-1: the order has 6 still to deliver, not 7.");
    await saveInvoiceDraft(as.sales_manager, part, { date: "2026-11-14", lines: [] });
    await expect(postInvoice(as.sales_manager, part)).rejects.toThrow("Enter how much of at least one line to invoice.");
    await saveInvoiceDraft(as.sales_manager, part, { date: "2026-11-14", lines: [{ sourceLineId: lineIds[0], quantity: "2" }] });
    expect(await postInvoice(as.sales_manager, part)).toMatchObject({ number: "SI-2627-00003" });
    expect(await stock(helmet)).toBe("5 worth 3000");
    expect((await getOrderDelivery(as.owner, orderId))!.map((l) => `${l.itemCode} ordered ${l.ordered.toFixed()} gone ${l.delivered.toFixed()} invoiced ${l.invoiced.toFixed()} left ${l.remaining.toFixed()}`)).toEqual(["HL-1 ordered 6 gone 2 invoiced 2 left 4", "CH-2 ordered 2 gone 0 invoiced 0 left 2"]);
    // The part invoiced is in the receivable; the rest of the order still counts as on order.
    const credit = await getCustomerCredit(as.owner, dealer);
    expect(`${credit!.receivable.toFixed(2)} ${credit!.openOrders.toFixed(2)}`).toBe("6962.00 5664.00");

    // The warehouse delivers the other 4 helmets and the chains; that note is then invoiced.
    const note = await deliver(as.warehouse_manager, orderId, "2026-11-15");
    expect((await getSalesDocument(as.owner, note))!.lines.map((l) => `${l.itemCode} ${l.quantity.toFixed()}`)).toEqual(["HL-1 4", "CH-2 2"]);
    expect(await stock(helmet)).toBe("1 worth 600");
    // Nothing is left on the order for a second invoice straight from it.
    await expect(startInvoice(as.sales_manager, orderId)).rejects.toThrow("Everything on this order has left the warehouse. Invoice its delivery notes instead.");
    const rest = await invoice(as.sales_manager, note, "2026-11-16");
    // Two people post the same invoice at the same moment: it is posted once.
    const twice = await Promise.allSettled([postInvoice(as.sales_manager, rest), postInvoice(as.owner, rest)]);
    expect(twice.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await admin`select count(*)::int as n from public.journals where source_type = 'sales_invoice' and source_id = ${rest}`)[0].n).toBe(1);
    expect(`${(await getCustomerCredit(as.owner, dealer))!.openOrders.toFixed(2)}`).toBe("0.00");

    // One helmet is left: an order for two cannot be invoiced straight away, in the app or past it.
    const tooMany = await order(as.salesperson, rider, "2026-11-16", [line(helmet, "2")]);
    const short = await invoice(as.salesperson, tooMany, "2026-11-16");
    await expect(postInvoice(as.salesperson, short)).rejects.toThrow("Not enough HL-1 in stock at Main store: 1 on hand, 2 needed. Stock is entered first; a sale never takes it below zero.");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.execute(sql`select * from app.post_sales_invoice(${short}::uuid)`)))).toBe("SE060");
    expect((await getSalesDocument(as.owner, short))!.status).toBe("draft");
    expect((await admin`select count(*)::int as n from public.journals where source_id = ${short}`)[0].n).toBe(0);
    await discardSalesDraft(as.salesperson, short);
    await cancelSalesDocument(as.salesperson, tooMany, { reason: "Out of stock" });
  });

  it("posts only through the database's own function, for the members who may, with figures that are still right", async () => {
    await seedStock(admin, { tenantId: tenantR, warehouseId: warehouseR, userId: userIds.owner, itemId: helmet, quantity: "9", value: "5400" });
    const orderId = await order(as.salesperson, rider, "2026-11-17", [line(helmet, "2")]);
    const id = await invoice(as.salesperson, orderId, "2026-11-17");
    const mine = and(eq(salesDocuments.tenantId, tenantR), eq(salesDocuments.id, id));

    // Marked posted by hand, an invoice has no journal and no stock move, so the transaction is refused.
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.update(salesDocuments).set({ status: "submitted", submittedBy: userIds.salesperson, updatedBy: userIds.salesperson }).where(mine)))).toBe("SE068");
    // Nobody writes an invoice's journal by hand, and a journal with no document is not kept.
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.execute(sql`select app.post_journal('2026-11-17'::date, 'sales_invoice', ${id}::uuid, '[]'::jsonb)`)))).toBe("23514");
    expect(await codeOf(() => withTenant(userIds.owner, tenantR, (tx) => tx.execute(sql`select app.control_account(${tenantR}::uuid, 'ar')`)))).toBe("42501");
    // Roles that do not invoice, and a salesperson whose sale it is not, get nowhere.
    for (const who of [as.warehouse_manager, as.auditor]) expect(await codeOf(() => withTenant(who.userId, tenantR, (tx) => tx.execute(sql`select * from app.post_sales_invoice(${id}::uuid)`))), who.role).toBe("42501");
    expect(await codeOf(() => withTenant(seller2, tenantR, (tx) => tx.execute(sql`select * from app.post_sales_invoice(${id}::uuid)`)))).toBe("SE063");
    expect(await codeOf(() => withTenant(ownerU, tenantU, (tx) => tx.execute(sql`select * from app.post_sales_invoice(${id}::uuid)`)))).toBe("SE063");
    await expect(postInvoice(second, id)).rejects.toThrow("That document is not in this company.");
    // Another salesperson cannot write an invoice against the order by their own SQL either.
    expect(await codeOf(() => withTenant(seller2, tenantR, (tx) => tx.insert(salesDocuments).values({ tenantId: tenantR, kind: "invoice", documentDate: "2026-11-17", customerId: rider, warehouseId: warehouseR, branchId: branchR, currency: "PKR", taxed: true, pricesIncludeTax: false, sourceDocumentId: orderId, createdBy: seller2, updatedBy: seller2 })))).toBe("SE066");
    // A line of the invoice keeps the order's price: one written at another price never gets in.
    const [orderLine] = await admin`select id, unit_id from public.sales_lines where document_id = ${orderId}`;
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, list_price, price_source, unit_price, value, total, source_line_id, created_by)
      values (${tenantR}, ${id}, 2, ${helmet}, 'Helmet', ${orderLine.unit_id}, 1, 1, 1000, 'item', 1, 1, 1, ${orderLine.id}, ${userIds.salesperson})`)))).toBe("SE052");

    // The rate changes after the draft was saved: what was saved is no longer right, so it is not posted.
    const [standard] = await admin<{ id: string }[]>`select id from public.tax_categories where tenant_id = ${tenantR} and kind = 'standard' order by created_at limit 1`;
    await setTaxRate(as.owner, { categoryId: standard.id, effectiveFrom: "2026-11-17", rate: "17", furtherTaxRate: "4", legalReference: "Test change of rate" });
    await expect(postInvoice(as.salesperson, id)).rejects.toThrow("A tax rate or the customer's tax status has changed since this invoice was saved. Check it and save it again.");
    const lines = (await getSalesDocument(as.salesperson, id))!.lines;
    await saveInvoiceDraft(as.salesperson, id, { date: "2026-11-17", lines: lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
    expect((await getSalesDocument(as.salesperson, id))!.lines.map(figures)).toEqual(["HL-1 2: 2000.00 + 340.00 + 80.00 = 2420.00"]);
    expect(await postInvoice(as.salesperson, id)).toMatchObject({ number: "SI-2627-00005" });
    expect(await journalOf("sales_invoice", id)).toEqual([
      "1200 Trade receivables | 2420.0000 | 0.0000 | Walk-in Rider",
      "4100 Sales | 0.0000 | 2000.0000",
      "2200 Sales tax payable (output tax) | 0.0000 | 340.0000",
      "2205 Further tax payable | 0.0000 | 80.0000",
      "5100 Cost of goods sold | 1200.0000 | 0.0000",
      "1300 Stock in trade | 0.0000 | 1200.0000",
    ]);

    // After everything: the ledger's receivable is the invoices' total, the stock account moved by exactly what left, and every journal has its document.
    const [ledger] = await admin`select coalesce(sum(l.debit - l.credit), 0)::text as owed from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantR} and a.control_type = 'ar'`;
    const [invoiced] = await admin`select sum(total)::text as total from public.sales_documents where tenant_id = ${tenantR} and kind = 'invoice' and status = 'submitted'`;
    expect(Number(ledger.owed)).toBe(Number(invoiced.total));
    const [stockAccount] = await admin`select coalesce(sum(l.credit - l.debit), 0)::text as out from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantR} and a.control_type = 'inventory'`;
    const [moved] = await admin`select coalesce(-sum(value), 0)::text as out from public.stock_moves where tenant_id = ${tenantR} and source_type in ('delivery_note', 'sales_invoice')`;
    expect(Number(stockAccount.out)).toBe(Number(moved.out));
    const orphans = await admin`select j.id from public.journals j where j.tenant_id = ${tenantR} and not exists (select 1 from public.sales_documents d where d.id = j.source_id and d.number = j.document_number)`;
    expect(orphans).toEqual([]);
  });

  it("keeps the invoice to what its order allowed: the discount, the salespeople, the credit limit, and figures the user has seen", async () => {
    await seedStock(admin, { tenantId: tenantR, warehouseId: warehouseR, userId: userIds.owner, itemId: chain, quantity: "40", value: "10800" });
    const shop = (await createParty(as.owner, "customer", { name: "Corner Shop", creditLimit: "5000" })).id;
    // 10 chains at 400 less 60% are 1,600 before tax. The buyer is not registered: 288 sales tax and 64 further tax, 1,952 in all, under the limit of 5,000.
    const orderId = await order(as.salesperson, shop, "2026-11-10", [line(chain, "10", { discountPercent: "60" })], warehouseR, [
      { userId: userIds.salesperson, percent: "60" },
      { userId: seller2, percent: "40" },
    ]);
    const id = await invoice(as.salesperson, orderId, "2026-11-10");
    const draft = (await getSalesDocument(as.salesperson, id))!;
    expect(draft.lines.map(figures)).toEqual(["CH-2 10: 1600.00 + 288.00 + 64.00 = 1952.00"]);
    const [stored] = await admin`select * from public.sales_lines where document_id = ${id}`;
    const rewrite = (change: Record<string, string>, header: Record<string, string>) =>
      withTenant(userIds.salesperson, tenantR, async (tx) => {
        await tx.delete(salesLineSalespeople).where(eq(salesLineSalespeople.documentId, id));
        await tx.delete(salesLines).where(eq(salesLines.documentId, id));
        await tx.execute(sql`insert into public.sales_lines select (jsonb_populate_record(null::public.sales_lines, ${JSON.stringify({ ...stored, ...change })}::text::jsonb)).*`);
        await tx.update(salesDocuments).set({ ...header, updatedBy: userIds.salesperson }).where(eq(salesDocuments.id, id));
      });
    // A discount is its percentage and nothing else: the line cannot be made to bill the full price, or nothing.
    expect(await codeOf(() => rewrite({ discount_amount: "0", value: "4000", tax_amount: "720", further_tax_amount: "160", total: "4880" }, { discountTotal: "0", valueTotal: "4000", taxTotal: "720", furtherTaxTotal: "160", total: "4880" }))).toBe("SE052");
    expect(await codeOf(() => rewrite({ discount_amount: "4000", value: "0", tax_amount: "0", further_tax_amount: "0", total: "0" }, { discountTotal: "4000", valueTotal: "0", taxTotal: "0", furtherTaxTotal: "0", total: "0" }))).toBe("SE052");
    // Tax written past the app, far above the order's: the invoice now comes to more than the order did and over the limit, so only the owner could post it.
    await rewrite({ tax_amount: "5288", total: "6952" }, { taxTotal: "5288", total: "6952" });
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.execute(sql`select * from app.post_sales_invoice(${id}::uuid)`)))).toBe("SE051");
    await expect(postInvoice(as.salesperson, id)).rejects.toThrow("A tax rate or the customer's tax status has changed since this invoice was saved.");

    // Saved again, the figures are the tax engine's; saving says whether anything moved.
    const lines = [{ sourceLineId: stored.source_line_id as string, quantity: "10" }];
    expect((await saveInvoiceDraft(as.salesperson, id, { date: "2026-11-10", lines })).changed).toBe(true);
    expect((await saveInvoiceDraft(as.salesperson, id, { date: "2026-11-10", lines })).changed).toBe(false);
    expect((await saveInvoiceDraft(as.salesperson, id, { date: "2026-11-11", lines })).changed).toBe(true);
    expect((await saveInvoiceDraft(as.salesperson, id, { date: "2026-11-11", lines: [{ ...lines[0], quantity: "4" }] })).changed).toBe(true);

    // The lead salesperson takes the whole sale for themselves on the draft: the posted invoice still carries the order's shares.
    const [invoiceLine] = await admin`select id from public.sales_lines where document_id = ${id}`;
    await withTenant(userIds.salesperson, tenantR, async (tx) => {
      await tx.delete(salesLineSalespeople).where(eq(salesLineSalespeople.documentId, id));
      await tx.insert(salesLineSalespeople).values({ tenantId: tenantR, documentId: id, lineId: invoiceLine.id, userId: userIds.salesperson, sharePercent: "100", createdBy: userIds.salesperson });
    });
    await postInvoice(as.salesperson, id);
    const shares = await admin`select user_id, share_percent::text from public.sales_line_salespeople where document_id = ${id} order by share_percent desc`;
    expect(shares.map((s) => `${s.user_id === userIds.salesperson ? "lead" : "second"} ${Number(s.share_percent)}`)).toEqual(["lead 60", "second 40"]);

    // Marked posted by hand, an invoice made from a delivery note is refused too, even one that comes to nothing.
    await seedStock(admin, { tenantId: tenantR, warehouseId: warehouseR, userId: userIds.owner, itemId: helmet, quantity: "5", value: "3000" });
    const freeOrder = await order(as.salesperson, rider, "2026-11-10", [line(helmet, "1", { discountPercent: "100" })]);
    const freeNote = await deliver(as.warehouse_manager, freeOrder, "2026-11-10");
    const free = await invoice(as.salesperson, freeNote, "2026-11-10");
    expect((await getSalesDocument(as.salesperson, free))!.totals.total.toFixed(2)).toBe("0.00");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.update(salesDocuments).set({ status: "submitted", submittedBy: userIds.salesperson, updatedBy: userIds.salesperson }).where(eq(salesDocuments.id, free))))).toBe("SE068");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantR, (tx) => tx.execute(sql`update public.sales_documents set posted_txid = 1 where id = ${free}`)))).toBe("42501");
    const [planted] = await withTenant(userIds.salesperson, tenantR, (tx) => tx.execute<{ posted_txid: string | null }>(sql`insert into public.sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, taxed, prices_include_tax, source_document_id, posted_txid, created_by, updated_by)
      values (${tenantR}, 'invoice', '2026-11-10', ${rider}, ${warehouseR}, ${branchR}, 'PKR', true, false, ${freeOrder}, 99, ${userIds.salesperson}, ${userIds.salesperson}) returning posted_txid`));
    expect(planted.posted_txid).toBeNull();
    // Posted properly, an invoice for nothing leaves no journal and still closes the note.
    expect(await postInvoice(as.salesperson, free)).toMatchObject({ number: expect.stringMatching(/^SI-/) });
    expect(await journalOf("sales_invoice", free)).toEqual([]);
    await expect(startInvoice(as.salesperson, freeNote)).rejects.toThrow("This delivery note has already been invoiced");
  });

  it("still bills goods already delivered when the customer, the item or the salesperson has gone since", async () => {
    const gloves = (await createItem(as.owner, { code: "GL-9", name: "Gloves", unit: (await admin`select id from public.units where tenant_id = ${tenantR} limit 1`)[0].id, defaultPrice: "200" })).id;
    await seedStock(admin, { tenantId: tenantR, warehouseId: warehouseR, userId: userIds.owner, itemId: gloves, quantity: "10", value: "1000" });
    const leaving = (await createParty(as.owner, "customer", { name: "Closing Down Stores" })).id;
    const orderId = await order(as.sales_manager, leaving, "2026-11-10", [line(gloves, "4")], warehouseR, [{ userId: seller2, percent: "100" }]);
    const note = await deliver(as.warehouse_manager, orderId, "2026-11-10");
    // After the goods have gone: the item and the customer are archived, and the salesperson leaves.
    await setItemArchived(as.owner, gloves, true);
    await setPartyArchived(as.owner, "customer", leaving, true);
    await admin`update public.memberships set active = false where tenant_id = ${tenantR} and user_id = ${seller2}`;
    const id = await invoice(as.sales_manager, note, "2026-11-10");
    expect(await postInvoice(as.sales_manager, id)).toMatchObject({ number: expect.stringMatching(/^SI-/) });
    expect(await journalOf("sales_invoice", id)).toEqual([
      "1200 Trade receivables | 976.0000 | 0.0000 | Closing Down Stores",
      "4100 Sales | 0.0000 | 800.0000",
      "2200 Sales tax payable (output tax) | 0.0000 | 144.0000",
      "2205 Further tax payable | 0.0000 | 32.0000",
    ]);
    expect((await admin`select user_id from public.sales_line_salespeople where document_id = ${id}`).map((r) => r.user_id)).toEqual([seller2]);
    // A new sale to the archived customer, or of the archived item, is still refused.
    await expect(saveSalesDraft(as.sales_manager, null, { kind: "order", date: "2026-11-10", customerId: leaving, warehouseId: warehouseR, lines: [line(helmet, "1")] })).rejects.toThrow("Closing Down Stores is archived.");
    await expect(saveSalesDraft(as.sales_manager, null, { kind: "order", date: "2026-11-10", customerId: rider, warehouseId: warehouseR, lines: [line(gloves, "1")] })).rejects.toThrow("GL-9 is archived and cannot be sold.");
    await admin`update public.memberships set active = true where tenant_id = ${tenantR} and user_id = ${seller2}`;

    // A locked month takes no invoice; with the tax inside the price, the price is what the buyer owes.
    const inside = await order(as.sales_manager, dealer, "2026-11-16", [line(helmet, "1", { unitPrice: "1180" })]);
    await admin`update public.company_setup set prices_include_tax = true where tenant_id = ${tenantR}`;
    const insideInvoice = await invoice(as.sales_manager, inside, "2026-11-16");
    const november = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-11-01")!;
    await setPeriodLocked(as.owner, november.id, true);
    await expect(postInvoice(as.sales_manager, insideInvoice)).rejects.toThrow("The period November 2026 is locked.");
    await setPeriodLocked(as.owner, november.id, false);
    expect((await getSalesDocument(as.sales_manager, insideInvoice))!.lines.map(figures)).toEqual(["HL-1 1: 1000.00 + 180.00 + 0.00 = 1180.00"]);
    await postInvoice(as.sales_manager, insideInvoice);
    expect((await journalOf("sales_invoice", insideInvoice)).slice(0, 3)).toEqual(["1200 Trade receivables | 1180.0000 | 0.0000 | Registered Dealer", "4100 Sales | 0.0000 | 1000.0000", "2200 Sales tax payable (output tax) | 0.0000 | 180.0000"]);
    await admin`update public.company_setup set prices_include_tax = false where tenant_id = ${tenantR}`;
  });

  it("invoices with no tax at all in a company that is not registered for sales tax", async () => {
    const piece = (await addUnit(plain, { code: "pc", name: "Piece" })).id;
    const pad = (await createItem(plain, { code: "BP-100", name: "Brake pad", unit: piece, defaultPrice: "110" })).id;
    const shop = (await createParty(plain, "customer", { name: "City Bikes", creditDays: "15" })).id;
    await seedStock(admin, { tenantId: tenantU, warehouseId: warehouseU, userId: ownerU, itemId: pad, quantity: "100", value: "7000" });
    const orderId = await order(plain, shop, "2026-11-10", [line(pad, "10", { discountPercent: "10" })], warehouseU);
    const id = await invoice(plain, orderId, "2026-11-10");
    expect((await getSalesDocument(plain, id))!.lines.map(figures)).toEqual(["BP-100 10: 990.00 + 0.00 + 0.00 = 990.00"]);
    expect(await postInvoice(plain, id)).toEqual({ number: "SI-2627-00001", dueDate: "2026-11-25" });
    expect(await journalOf("sales_invoice", id)).toEqual([
      "1200 Trade receivables | 990.0000 | 0.0000 | City Bikes",
      "4100 Sales | 0.0000 | 990.0000",
      "5100 Cost of goods sold | 700.0000 | 0.0000",
      "1300 Stock in trade | 0.0000 | 700.0000",
    ]);
    expect(await balances(tenantU)).toEqual(["1200 Trade receivables 990.0000", "1300 Stock in trade -700.0000", "4100 Sales -990.0000", "5100 Cost of goods sold 700.0000"]);
  });
});
