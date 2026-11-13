import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { getConnection } from "@/db/client";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem, setItemUnit } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { listAccounts } from "@/modules/ledger/queries";
import { openFiscalYear } from "@/modules/numbering/commands";
import { addOpenDocument, postOpening, setAccountBalance, startOpening } from "@/modules/opening/commands";
import { createParty, setPartyArchived, updateParty } from "@/modules/parties/commands";
import { getParty } from "@/modules/parties/queries";
import { setCustomerPrice } from "@/modules/prices/commands";
import { salesDocumentLinks } from "./schema";
import { setTaxRate } from "@/modules/tax/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { NeedsReason, cancelSalesDocument, discardSalesDraft, orderFromQuotation, releaseSalesHold, saveSalesDraft, submitSalesDocument } from "./commands";
import { getCustomerCredit, getLineDefaults, getSalesDocument, listOrdersOnHold, listSalesDocuments, listSalesPeople, searchItems } from "./queries";
import type { RawDocument } from "./rules";
import { salesDocuments, salesLineSalespeople, salesLines } from "./schema";
import { customers } from "@/modules/parties/schema";
import { auditLog } from "@/modules/tenant/schema";

// Quotations and sales orders against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-sales-test";
const tenantA = randomUUID(); // not registered for sales tax
const tenantR = randomUUID(); // registered, tax added on top of prices
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const seller2 = randomUUID();
const cityManager = randomUUID();
const ownerR = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const mainWarehouse = randomUUID();
const cityWarehouse = randomUUID();
const warehouseR = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@sales.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const second = ctx(seller2, tenantA, "salesperson");
const scoped = ctx(cityManager, tenantA, "sales_manager", [cityBranch]);
const registered = ctx(ownerR, tenantR, "owner");
const otherOwner = ctx(ownerB, tenantB, "owner");
const D = "2026-11-13";

let admin: AdminSql;
let piece: string;
let carton: string;
let pad: string; // BP-100, 110 a piece, also sold in cartons of 12
let chain: string; // CH-200, no price anywhere
let khan: string; // credit limit 50,000, owes 30,000 from before
let city: string; // no credit limit
let gone: string; // archived

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

const line = (itemId: string, quantity: string, extra: { unitId?: string; unitPrice?: string; discountPercent?: string; description?: string } = {}) => ({ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "", ...extra });
const order = (customerId: string, lines: ReturnType<typeof line>[], extra: Partial<RawDocument> = {}): RawDocument => ({ kind: "order", date: D, customerId, warehouseId: mainWarehouse, lines, ...extra });
const quotation = (customerId: string, lines: ReturnType<typeof line>[], extra: Partial<RawDocument> = {}): RawDocument => ({ ...order(customerId, lines, extra), kind: "quotation" });
const figures = (l: { quantity: { toFixed(): string }; unitPrice: { toFixed(n: number): string }; discountAmount: { toFixed(n: number): string }; value: { toFixed(n: number): string }; taxAmount: { toFixed(n: number): string }; furtherTaxAmount: { toFixed(n: number): string }; total: { toFixed(n: number): string } }) =>
  `${l.quantity.toFixed()} @ ${l.unitPrice.toFixed(2)} - ${l.discountAmount.toFixed(2)} = ${l.value.toFixed(2)} + ${l.taxAmount.toFixed(2)} + ${l.furtherTaxAmount.toFixed(2)} = ${l.total.toFixed(2)}`;
const auditOf = (entityId: string, action: string) => admin<{ actor_role: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]>`select actor_role, before, after from public.audit_log where entity_id = ${entityId} and action = ${action} order by at`;

describe.skipIf(!hasDb)("quotations and sales orders", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantR}, ${PREFIX + " R"}, ${ownerR}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    const branchR = randomUUID();
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branchR}, ${tenantR}, 'Main', ${ownerR})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values
      (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${cityWarehouse}, ${tenantA}, ${cityBranch}, 'City store', ${userIds.owner}), (${warehouseR}, ${tenantR}, ${branchR}, 'Main store', ${ownerR})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: seller2, email: second.email, role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantA, user_id: cityManager, email: scoped.email, role: "sales_manager", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantR, user_id: ownerR, email: registered.email, role: "owner", branch_ids: null, created_by: ownerR },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
      // Two members of A who also own a company of their own: what a switch of company in mid-statement needs.
      { tenant_id: tenantB, user_id: userIds.accountant, email: as.accountant.email, role: "owner", branch_ids: null, created_by: ownerB },
      { tenant_id: tenantB, user_id: seller2, email: second.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantR}, true, '1234567890123', now(), 'trading', ${ownerR})`;
    await admin`select app.seed_tax_defaults(${tenantR}, ${ownerR})`;
    for (const owner of [as.owner, registered]) {
      await setBaseCurrency(owner, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(owner, "trading");
      await openFiscalYear(owner, { month: "7", year: "2026" });
    }
    piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    carton = (await addUnit(as.owner, { code: "ctn", name: "Carton" })).id;
    pad = (await createItem(as.owner, { code: "BP-100", name: "Brake pad", unit: piece, defaultPrice: "110" })).id;
    await setItemUnit(as.owner, pad, { unit: carton, factor: "12" });
    chain = (await createItem(as.owner, { code: "CH-200", name: "Chain", unit: piece })).id;
    khan = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", creditLimit: "50000" })).id;
    city = (await createParty(as.owner, "customer", { name: "City Bikes", code: "C-002" })).id;
    gone = (await createParty(as.owner, "customer", { name: "Closed Shop" })).id;
    await setPartyArchived(as.owner, "customer", gone, true);
    // Khan Autos already owes 30,000 from before the books were opened.
    const chart = await listAccounts(as.owner);
    await startOpening(as.owner, { date: "2026-07-01" });
    await addOpenDocument(as.owner, "receivable", { party: "C-001", documentNumber: "OLD-1", documentDate: "2026-06-01", amount: "30000" });
    await setAccountBalance(as.owner, { accountId: chart.find((a) => a.code === "3100")!.id, debit: "", credit: "30000" });
    await postOpening(as.owner);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantR, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("saves a draft with every line worked out: list price, carton price, a typed price and a discount", async () => {
    for (const role of ["auditor", "warehouse_manager"] as const) await expect(saveSalesDraft(as[role], null, quotation(city, [line(pad, "2")])), role).rejects.toThrow("Your role cannot write sales documents.");
    await expect(saveSalesDraft(as.salesperson, null, quotation("", [line(pad, "2")]))).rejects.toThrow("Choose the customer.");
    await expect(saveSalesDraft(as.salesperson, null, quotation(gone, [line(pad, "2")]))).rejects.toThrow("Closed Shop is archived.");
    await expect(saveSalesDraft(as.salesperson, null, quotation(city, [line(pad, "2"), line(chain, "1")]))).rejects.toThrow("Line 2: CH-200 has no price for this customer. Enter the price.");
    await expect(saveSalesDraft(as.salesperson, null, quotation(city, [line(randomUUID(), "1")]))).rejects.toThrow("Line 1: choose an item.");
    await expect(saveSalesDraft(as.salesperson, null, quotation(city, [line(chain, "1", { unitId: carton, unitPrice: "5" })]))).rejects.toThrow("Line 1: CH-200 is not sold in that unit.");
    await expect(saveSalesDraft(as.salesperson, null, quotation(city, [line(pad, "2")], { warehouseId: randomUUID() }))).rejects.toThrow("Choose one of your warehouses.");

    const { id } = await saveSalesDraft(as.salesperson, null, quotation(city, [line(pad, "24"), line(pad, "2", { unitId: carton }), line(chain, "3", { unitPrice: "450.50" }), line(pad, "10", { unitPrice: "100", discountPercent: "2.5" })], { validUntil: "2026-11-30", customerReference: "PO 77", notes: "Deliver before noon" }));
    const draft = await getSalesDocument(as.salesperson, id);
    expect(draft).toMatchObject({ kind: "quotation", status: "draft", number: null, date: D, validUntil: "2026-11-30", customerName: "City Bikes", warehouseName: "Main store", branchId: mainBranch, currency: "PKR", taxed: false, pricesIncludeTax: false, customerReference: "PO 77", notes: "Deliver before noon" });
    expect(draft!.lines.map((l) => `${l.lineNo} ${l.itemCode} ${l.unitCode} base ${l.baseQuantity.toFixed()} list ${l.listPrice?.toFixed(2) ?? "none"} ${l.priceSource ?? "typed"}: ${figures(l)}`)).toEqual([
      "1 BP-100 pc base 24 list 110.00 item: 24 @ 110.00 - 0.00 = 2640.00 + 0.00 + 0.00 = 2640.00",
      "2 BP-100 ctn base 24 list 1320.00 item: 2 @ 1320.00 - 0.00 = 2640.00 + 0.00 + 0.00 = 2640.00",
      "3 CH-200 pc base 3 list none typed: 3 @ 450.50 - 0.00 = 1351.50 + 0.00 + 0.00 = 1351.50",
      "4 BP-100 pc base 10 list 110.00 item: 10 @ 100.00 - 25.00 = 975.00 + 0.00 + 0.00 = 975.00",
    ]);
    expect(draft!.lines[0].description).toBe("Brake pad");
    expect(`${draft!.totals.gross.toFixed(2)} ${draft!.totals.discount.toFixed(2)} ${draft!.totals.value.toFixed(2)} ${draft!.totals.total.toFixed(2)}`).toBe("7631.50 25.00 7606.50 7606.50");
    // A price that is not the list's, and a discount, are kept in the log with who gave them.
    const [created] = await auditOf(id, "sales_quotation.create");
    expect(created.actor_role).toBe("salesperson");
    expect(created.after?.priceChanges).toEqual([
      { item: "Chain", list: null, charged: "450.5000", discount: null },
      { item: "Brake pad", list: "110.0000", charged: "100.0000", discount: "2.5%" },
    ]);

    // Saving again replaces the lines; a form opened before that cannot overwrite it; the kind never changes.
    await saveSalesDraft(as.salesperson, id, quotation(city, [line(pad, "5")]), draft!.updatedAt.toISOString());
    await expect(saveSalesDraft(as.salesperson, id, quotation(city, [line(pad, "9")]), draft!.updatedAt.toISOString())).rejects.toThrow("Someone changed this document after you opened it.");
    await expect(saveSalesDraft(as.salesperson, id, order(city, [line(pad, "5")]))).rejects.toThrow("This is a quotation; what a document is never changes.");
    const changed = await getSalesDocument(as.salesperson, id);
    expect(changed!.lines.map(figures)).toEqual(["5 @ 110.00 - 0.00 = 550.00 + 0.00 + 0.00 = 550.00"]);
    expect((await auditOf(id, "sales_quotation.update"))[0]).toMatchObject({ actor_role: "salesperson", before: { lines: 4, total: "7606.5000" }, after: { lines: 1, total: "550.0000" } });

    // A customer's own price wins over the item's.
    await setCustomerPrice(as.owner, { item: pad, customer: city, price: "95", validFrom: "2026-11-01", validTo: "" });
    expect(await getLineDefaults(as.salesperson, { itemId: pad, customerId: city, date: D })).toMatchObject({ code: "BP-100", name: "Brake pad", listPrice: "95", units: [{ code: "pc", factor: "1" }, { code: "ctn" }] });
    expect((await searchItems(as.salesperson, "bp-100")).map((c) => `${c.label} ${c.sub}`)).toEqual(["BP-100 Brake pad"]);

    // A draft with no lines can be kept, not submitted; a draft can be thrown away and leaves nothing.
    const empty = await saveSalesDraft(as.sales_manager, null, quotation(city, []));
    await expect(submitSalesDocument(as.sales_manager, empty.id)).rejects.toThrow("A quotation needs at least one line.");
    await discardSalesDraft(as.sales_manager, empty.id);
    expect(await getSalesDocument(as.owner, empty.id)).toBeNull();
    await discardSalesDraft(as.salesperson, id);
    expect((await admin`select count(*)::int as n from public.sales_lines where document_id = ${id}`)[0].n).toBe(0);
    expect((await auditOf(id, "sales_quotation.discard"))[0]).toMatchObject({ actor_role: "salesperson", before: { customer: "City Bikes", lines: 1 }, after: null });
  });

  it("submits a quotation with its number, after which nothing about it changes", async () => {
    const { id } = await saveSalesDraft(as.salesperson, null, quotation(city, [line(pad, "10")]));
    await expect(submitSalesDocument(as.auditor, id)).rejects.toThrow("Your role cannot write sales documents.");
    const result = await submitSalesDocument(as.salesperson, id);
    expect(result).toEqual({ status: "submitted", number: "QT-2627-00001" });
    expect((await auditOf(id, "sales_quotation.submit"))[0]).toMatchObject({ actor_role: "salesperson", after: { number: "QT-2627-00001", kind: "quotation", customer: "City Bikes", lines: 1, total: "950.0000" } });
    const sent = await getSalesDocument(as.auditor, id);
    expect(sent).toMatchObject({ status: "submitted", number: "QT-2627-00001", customerName: "City Bikes", creditLimit: null });
    expect((await admin`select buyer_name, buyer_registration_type, buyer_atl_status, submitted_by from public.sales_documents where id = ${id}`)[0]).toMatchObject({ buyer_name: "City Bikes", buyer_registration_type: "unregistered", buyer_atl_status: "unknown", submitted_by: userIds.salesperson });

    await expect(saveSalesDraft(as.salesperson, id, quotation(city, [line(pad, "1")]))).rejects.toThrow("This document is submitted and cannot be changed.");
    await expect(discardSalesDraft(as.salesperson, id)).rejects.toThrow("Only a draft can be thrown away.");
    await expect(submitSalesDocument(as.salesperson, id)).rejects.toThrow("This quotation is already submitted.");
    // Whatever the app is asked, the database itself refuses to change or remove it or its lines.
    const mine = and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, id));
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(salesDocuments).set({ total: "1", valueTotal: "1", updatedBy: userIds.owner }).where(mine)))).toBe("SE050");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(salesDocuments).set({ status: "draft", updatedBy: userIds.owner }).where(mine)))).toBe("SE050");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.delete(salesLines).where(and(eq(salesLines.tenantId, tenantA), eq(salesLines.documentId, id)))))).toBe("SE050");
    expect(await withTenant(userIds.owner, tenantA, (tx) => tx.delete(salesDocuments).where(mine).returning({ id: salesDocuments.id }))).toEqual([]);

    // The customer's name changes afterwards; the quotation still says who it was written to.
    const stored = await getParty(as.owner, "customer", city);
    await updateParty(as.owner, "customer", city, { name: "City Bikes and Parts", code: "C-002" }, stored!.updatedAt.toISOString());
    expect((await getSalesDocument(as.owner, id))!.customerName).toBe("City Bikes");

    // An order is started from it: the same lines and prices, a link back, dated today.
    const made = await orderFromQuotation(as.salesperson, id);
    const madeOrder = await getSalesDocument(as.salesperson, made.id);
    expect(madeOrder).toMatchObject({ kind: "order", status: "draft", customerName: "City Bikes and Parts", madeFrom: [{ id, kind: "quotation", number: "QT-2627-00001" }] });
    expect(madeOrder!.lines.map(figures)).toEqual(["10 @ 95.00 - 0.00 = 950.00 + 0.00 + 0.00 = 950.00"]);
    expect((await getSalesDocument(as.owner, id))!.madeInto).toMatchObject([{ id: made.id, kind: "order", number: null, status: "draft" }]);
    await discardSalesDraft(as.salesperson, made.id);
    expect((await getSalesDocument(as.owner, id))!.madeInto).toEqual([]);

    // Cancelling needs a reason, keeps the number, and happens once.
    await expect(cancelSalesDocument(as.salesperson, id, { reason: " " })).rejects.toThrow("Say why it is cancelled, in a few words.");
    await cancelSalesDocument(as.salesperson, id, { reason: "Customer chose another supplier" });
    expect(await getSalesDocument(as.owner, id)).toMatchObject({ status: "cancelled", number: "QT-2627-00001", cancelReason: "Customer chose another supplier" });
    await expect(cancelSalesDocument(as.owner, id, { reason: "Again" })).rejects.toThrow("This document is already cancelled.");
    await expect(orderFromQuotation(as.salesperson, id)).rejects.toThrow("This quotation is cancelled.");
    expect((await auditOf(id, "sales_quotation.cancel"))[0].after).toMatchObject({ status: "cancelled", reason: "Customer chose another supplier" });
  });

  it("shows a salesperson their own documents, a branch its own, and a company nothing of another's", async () => {
    const mine = await saveSalesDraft(as.salesperson, null, order(city, [line(pad, "1")]));
    const theirs = await saveSalesDraft(second, null, order(city, [line(pad, "2")]));
    const cityOrder = await saveSalesDraft(scoped, null, order(city, [line(pad, "3")], { warehouseId: cityWarehouse }));
    expect(await getSalesDocument(as.salesperson, mine.id)).not.toBeNull();
    expect(await getSalesDocument(as.salesperson, theirs.id)).toBeNull();
    expect(await getSalesDocument(second, mine.id)).toBeNull();
    await expect(saveSalesDraft(second, mine.id, order(city, [line(pad, "9")]))).rejects.toThrow("That document is not in this company.");
    for (const role of ["owner", "accountant", "auditor", "sales_manager"] as const) expect(await getSalesDocument(as[role], theirs.id), role).not.toBeNull();
    // The warehouse reads delivery notes and the submitted orders behind them, never a draft order.
    expect(await getSalesDocument(as.warehouse_manager, mine.id)).toBeNull();
    expect(await withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.select({ id: salesDocuments.id }).from(salesDocuments))).toEqual([]);
    expect(await withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.select({ id: salesLines.id }).from(salesLines))).toEqual([]);

    // A manager who works in one branch sees and writes that branch's documents only.
    expect(await getSalesDocument(scoped, cityOrder.id)).toMatchObject({ branchId: cityBranch, warehouseName: "City store" });
    expect(await getSalesDocument(scoped, mine.id)).toBeNull();
    await expect(saveSalesDraft(scoped, null, order(city, [line(pad, "1")]))).rejects.toThrow("Choose one of your warehouses.");
    expect((await listSalesDocuments(scoped, { kind: "order" })).rows.map((r) => r.id)).toEqual([cityOrder.id]);
    expect((await listSalesDocuments(as.salesperson, { kind: "order" })).rows.map((r) => r.id)).toEqual([mine.id]);

    // A sale credited to someone is theirs to see.
    const shared = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "4")], { shares: [{ userId: seller2, percent: "100" }] }));
    expect(await getSalesDocument(second, shared.id)).toMatchObject({ salespersonId: seller2 });
    expect(await getSalesDocument(as.salesperson, shared.id)).toBeNull();

    // A salesperson cannot give away a sale someone else wrote for them: it would leave their own sight.
    await expect(saveSalesDraft(second, shared.id, order(city, [line(pad, "4")], { shares: [{ userId: userIds.salesperson, percent: "100" }] }))).rejects.toThrow("this sale was written for you by someone else, so the largest share stays yours");

    // Another company sees none of it and cannot write into it.
    expect(await getSalesDocument(otherOwner, mine.id)).toBeNull();
    expect((await listSalesDocuments(otherOwner, { kind: "order" })).rows).toEqual([]);
    expect(await codeOf(() => withTenant(ownerB, tenantB, (tx) => tx.insert(salesDocuments).values({ tenantId: tenantA, kind: "order", documentDate: D, customerId: city, warehouseId: mainWarehouse, branchId: mainBranch, currency: "PKR", taxed: false, pricesIncludeTax: false, createdBy: ownerB, updatedBy: ownerB })))).toBe("42501");
    for (const id of [mine.id, theirs.id, cityOrder.id, shared.id]) await discardSalesDraft(as.owner, id);
  });

  it("splits a sale between salespeople in shares that come to 100", async () => {
    expect((await listSalesPeople(as.salesperson)).map((p) => p.role).sort()).toEqual(["owner", "sales_manager", "sales_manager", "salesperson", "salesperson"]);
    await expect(listSalesPeople(as.warehouse_manager)).rejects.toThrow("Your role does not include sales documents.");
    const shares = (a: string, b: string) => [{ userId: userIds.salesperson, percent: a }, { userId: seller2, percent: b }];
    await expect(saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "1")], { shares: shares("60", "30") }))).rejects.toThrow("Salespeople: the shares come to 90%, not 100%.");
    await expect(saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "1")], { shares: [{ userId: userIds.accountant, percent: "100" }] }))).rejects.toThrow("Salespeople: choose an active owner, sales manager or salesperson of this company.");
    const { id } = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "1"), line(pad, "2")], { shares: shares("40", "60") }));
    const draft = await getSalesDocument(as.sales_manager, id);
    expect(draft!.shares.map((s) => `${s.userId === seller2 ? "second" : "first"} ${s.percent.toFixed()}`)).toEqual(["second 60", "first 40"]);
    expect(draft!.salespersonId).toBe(seller2);
    expect((await admin`select count(*)::int as n from public.sales_line_salespeople where document_id = ${id}`)[0].n).toBe(4);

    // The database refuses shares that do not come to 100, and a share for someone outside the sales team.
    const [first] = draft!.lines;
    await withTenant(userIds.sales_manager, tenantA, (tx) => tx.delete(salesLineSalespeople).where(and(eq(salesLineSalespeople.tenantId, tenantA), eq(salesLineSalespeople.lineId, first.id), eq(salesLineSalespeople.userId, seller2))));
    await expect(submitSalesDocument(as.sales_manager, id)).rejects.toThrow("This document could not be submitted as it stands.");
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.insert(salesLineSalespeople).values({ tenantId: tenantA, documentId: id, lineId: first.id, userId: userIds.accountant, sharePercent: "60", createdBy: userIds.sales_manager })))).toBe("SE052");
    await discardSalesDraft(as.sales_manager, id);
  });

  it("blocks an order over the credit limit until the owner approves it with a reason", async () => {
    expect(await getCustomerCredit(as.salesperson, khan)).toMatchObject({ limit: expect.anything(), receivable: expect.anything() });
    const before = await getCustomerCredit(as.salesperson, khan);
    expect(`${before!.limit!.toFixed(2)} ${before!.receivable.toFixed(2)} ${before!.openOrders.toFixed(2)}`).toBe("50000.00 30000.00 0.00");
    await expect(getCustomerCredit(as.warehouse_manager, khan)).rejects.toThrow("Your role does not include sales documents.");
    expect(await codeOf(() => withTenant(userIds.warehouse_manager, tenantA, (tx) => tx.execute(sql`select * from app.customer_credit(${khan}::uuid)`)))).toBe("42501");

    // 30,000 owed + 15,400 fits under 50,000.
    const fits = await saveSalesDraft(as.salesperson, null, order(khan, [line(pad, "140")]));
    expect(await submitSalesDocument(as.salesperson, fits.id)).toEqual({ status: "submitted", number: "SO-2627-00001" });
    expect(await getSalesDocument(as.salesperson, fits.id)).toMatchObject({ status: "submitted", creditOverrideReason: null });
    const kept = (await admin`select credit_limit::text, credit_exposure::text from public.sales_documents where id = ${fits.id}`)[0];
    expect(kept).toEqual({ credit_limit: "50000.0000", credit_exposure: "30000.0000" });

    // 30,000 + 15,400 on order + 11,000 does not: the salesperson's order waits for the owner.
    const over = await saveSalesDraft(as.salesperson, null, order(khan, [line(pad, "100")]));
    const held = await submitSalesDocument(as.salesperson, over.id);
    expect(held).toEqual({ status: "on_hold", message: "This order of 11,000.00 takes the customer 6,400.00 over the credit limit of 50,000.00: the customer owes 30,000.00 and has 15,400.00 in other orders. It now waits for the owner's approval." });
    expect(await getSalesDocument(as.salesperson, over.id)).toMatchObject({ status: "on_hold", number: null });
    expect((await listOrdersOnHold(as.owner)).map((o) => `${o.customerName} ${o.total.toFixed(2)}`)).toEqual(["Khan Autos 11000.00"]);
    expect((await auditOf(over.id, "sales_order.hold"))[0].after).toMatchObject({ creditLimit: "50000.0000", owed: "30000.0000", otherOrders: "15400.0000" });

    // While it waits it cannot be changed, and nobody but the owner can let it through.
    await expect(saveSalesDraft(as.salesperson, over.id, order(khan, [line(pad, "1")]))).rejects.toThrow("This order is waiting for approval. Take it back to a draft to change it.");
    await expect(submitSalesDocument(as.salesperson, over.id)).rejects.toThrow("This order is waiting for the owner's approval.");
    await expect(submitSalesDocument(as.sales_manager, over.id)).rejects.toThrow("This order is waiting for the owner's approval.");
    const mine = and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, over.id));
    const forced = { status: "submitted", number: "SO-2627-00099", submittedBy: userIds.sales_manager, buyerName: "Khan Autos", buyerRegistrationType: "unregistered", buyerAtlStatus: "unknown", updatedBy: userIds.sales_manager };
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set(forced).where(mine)))).toBe("SE051");
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ ...forced, creditOverrideReason: "I say so", creditOverrideBy: userIds.owner }).where(mine)))).toBe("SE051");

    // The owner must say why; the reason is kept on the order and in the log.
    const refused = await submitSalesDocument(as.owner, over.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NeedsReason);
    expect((refused as Error).message).toBe("This order of 11,000.00 takes the customer 6,400.00 over the credit limit of 50,000.00: the customer owes 30,000.00 and has 15,400.00 in other orders. As the owner you can approve it: say why this order is approved over the credit limit, in a few words.");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(salesDocuments).set({ ...forced, submittedBy: userIds.owner, updatedBy: userIds.owner }).where(mine)))).toBe("SE053");
    // The owner's own SQL cannot invent the number, the buyer or the time: the database supplies them.
    await withTenant(userIds.owner, tenantA, (tx) => tx.update(salesDocuments).set({ ...forced, number: "SO-2627-00099", buyerName: "Somebody Else", buyerAddress: "x".repeat(5000), submittedBy: userIds.owner, updatedBy: userIds.owner, creditOverrideReason: "  Cheque for 20,000 arrives on Monday " }).where(mine));
    expect((await admin`select number, buyer_name, buyer_address from public.sales_documents where id = ${over.id}`)[0]).toEqual({ number: "SO-2627-00002", buyer_name: "Khan Autos", buyer_address: null });
    expect(await getSalesDocument(as.salesperson, over.id)).toMatchObject({ status: "submitted", number: "SO-2627-00002", creditOverrideReason: "Cheque for 20,000 arrives on Monday" });
    // Through the app, the owner's approval of a held order needs the same reason.
    const held2 = await saveSalesDraft(as.salesperson, null, order(khan, [line(pad, "90")]));
    expect(await submitSalesDocument(as.salesperson, held2.id)).toMatchObject({ status: "on_hold" });
    await expect(submitSalesDocument(as.owner, held2.id, undefined, { reason: "ok" })).rejects.toBeInstanceOf(NeedsReason);
    expect(await submitSalesDocument(as.owner, held2.id, undefined, { reason: "Agreed by phone" })).toEqual({ status: "submitted", number: "SO-2627-00003" });
    await cancelSalesDocument(as.owner, held2.id, { reason: "Entered twice" });
    expect((await admin`select credit_override_by, credit_exposure::text, held_at from public.sales_documents where id = ${over.id}`)[0]).toEqual({ credit_override_by: userIds.owner, credit_exposure: "45400.0000", held_at: null });
    const [override] = await auditOf(over.id, "sales_order.credit_override");
    expect(override).toMatchObject({ actor_role: "owner", before: { creditLimit: "50000.0000", owed: "30000.0000", otherOrders: "15400.0000" }, after: { orderTotal: "11000.0000", over: "6400.0000", reason: "Cheque for 20,000 arrives on Monday" } });
    expect(await listOrdersOnHold(as.owner)).toEqual([]);

    // An order under the limit cannot be parked; one over it can be taken back and made smaller.
    const again = await saveSalesDraft(as.salesperson, null, order(khan, [line(pad, "10")]));
    expect(await submitSalesDocument(as.salesperson, again.id)).toMatchObject({ status: "on_hold" });
    await releaseSalesHold(as.salesperson, again.id);
    expect(await getSalesDocument(as.salesperson, again.id)).toMatchObject({ status: "draft" });
    expect((await auditOf(again.id, "sales_order.release"))[0]).toMatchObject({ actor_role: "salesperson", before: { status: "on_hold" }, after: { status: "draft" } });
    await expect(releaseSalesHold(as.salesperson, again.id)).rejects.toThrow("This order is not waiting for approval.");
    const small = await saveSalesDraft(as.salesperson, null, order(city, [line(pad, "1")]));
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.update(salesDocuments).set({ status: "on_hold", heldBy: userIds.salesperson, updatedBy: userIds.salesperson }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, small.id)))))).toBe("SE054");
    await discardSalesDraft(as.salesperson, small.id);

    // Cancelling an order gives its room back.
    await cancelSalesDocument(as.sales_manager, over.id, { reason: "Customer postponed" });
    expect((await getCustomerCredit(as.owner, khan))!.openOrders.toFixed(2)).toBe("15400.00");
    await saveSalesDraft(as.salesperson, again.id, order(khan, [line(pad, "40")]));
    expect(await submitSalesDocument(as.salesperson, again.id)).toEqual({ status: "submitted", number: "SO-2627-00004" });

    // A customer with no limit is never checked; a quotation never is.
    const free = await saveSalesDraft(as.salesperson, null, order(city, [line(pad, "100000")]));
    expect(await submitSalesDocument(as.salesperson, free.id)).toMatchObject({ status: "submitted" });
    const quote = await saveSalesDraft(as.salesperson, null, quotation(khan, [line(pad, "100000")]));
    expect(await submitSalesDocument(as.salesperson, quote.id)).toMatchObject({ status: "submitted" });
  });

  it("lets only one of two orders through when together they pass the limit", async () => {
    // Khan Autos: 30,000 owed + 15,400 + 4,400 on order = 49,800. Two orders of 110 each: one fits, two do not.
    const ids = await Promise.all([0, 1].map(async () => (await saveSalesDraft(as.sales_manager, null, order(khan, [line(pad, "1")]))).id));
    const results = await Promise.all(ids.map((id) => submitSalesDocument(as.sales_manager, id)));
    expect(results.map((r) => r.status).sort()).toEqual(["on_hold", "submitted"]);
    for (const id of ids) {
      const document = await getSalesDocument(as.owner, id);
      if (document!.status === "on_hold") await releaseSalesHold(as.owner, id);
      else await cancelSalesDocument(as.owner, id, { reason: "Test order" });
    }
  });

  it("refuses to submit totals that are not the lines' own, or a line that does not add up", async () => {
    const { id } = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "3")]));
    const mine = and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, id));
    await withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ total: "1", valueTotal: "1", updatedBy: userIds.sales_manager }).where(mine));
    await expect(submitSalesDocument(as.sales_manager, id)).rejects.toThrow("This document could not be submitted as it stands.");
    // A line written past the app, at a price its amounts do not match.
    await saveSalesDraft(as.sales_manager, id, order(city, [line(pad, "3")]));
    await withTenant(userIds.sales_manager, tenantA, async (tx) => {
      await tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, unit_price, value, total, created_by)
        values (${tenantA}, ${id}, 2, ${pad}, 'Cheap', ${piece}, 5, 5, 100, 1, 1, ${userIds.sales_manager})`);
      await tx.update(salesDocuments).set({ grossTotal: "785", total: "286", valueTotal: "286", updatedBy: userIds.sales_manager }).where(mine);
    });
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ status: "submitted", number: "SO-2627-00077", submittedBy: userIds.sales_manager, buyerName: "City Bikes and Parts", buyerRegistrationType: "unregistered", buyerAtlStatus: "unknown", updatedBy: userIds.sales_manager }).where(mine)))).toBe("SE052");
    // A line in a unit the item is not sold in, or at a size that is not the unit's, never gets in.
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, unit_factor, quantity, base_quantity, unit_price, value, total, created_by)
      values (${tenantA}, ${id}, 3, ${pad}, 'Wrong size', ${carton}, 10, 1, 10, 100, 100, 100, ${userIds.sales_manager})`)))).toBe("SE052");
    await discardSalesDraft(as.sales_manager, id);
  });

  it("keeps the credit check out of reach: the limit, the currency, the snapshot the checks read, the period", async () => {
    // Only the owner moves a customer's credit limit, in the app and in the database.
    const stored = await getParty(as.owner, "customer", khan);
    for (const role of ["accountant", "sales_manager"] as const) {
      await expect(updateParty(as[role], "customer", khan, { name: "Khan Autos", code: "C-001", creditLimit: "99999999" }, stored!.updatedAt.toISOString()), role).rejects.toThrow("Only the owner changes a customer's credit limit.");
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.update(customers).set({ creditLimit: "99999999", updatedBy: userIds[role] }).where(and(eq(customers.tenantId, tenantA), eq(customers.id, khan))))), role).toBe("SE055");
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.update(customers).set({ creditLimit: null, updatedBy: userIds[role] }).where(and(eq(customers.tenantId, tenantA), eq(customers.id, khan))))), role).toBe("SE055");
    }
    // Other fields are still theirs to change; "not a number" is no limit for anyone.
    await updateParty(as.sales_manager, "customer", khan, { name: "Khan Autos", code: "C-001", creditLimit: "50000", creditDays: "30" }, stored!.updatedAt.toISOString());
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(customers).set({ creditLimit: "NaN", updatedBy: userIds.owner }).where(and(eq(customers.tenantId, tenantA), eq(customers.id, khan)))))).toBe("23514");
    expect((await getCustomerCredit(as.owner, khan))!.limit!.toFixed(2)).toBe("50000.00");

    // A document is in the base currency at a rate of one: a small rate would make any order fit.
    const draft = { tenantId: tenantA, kind: "order", documentDate: D, customerId: khan, warehouseId: mainWarehouse, branchId: mainBranch, currency: "PKR", taxed: false, pricesIncludeTax: false, createdBy: userIds.salesperson, updatedBy: userIds.salesperson };
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.insert(salesDocuments).values({ ...draft, exchangeRate: "0.00000001" })))).toBe("SE052");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.insert(salesDocuments).values({ ...draft, currency: "USD" })))).toBe("SE052");
    const big = await saveSalesDraft(as.salesperson, null, order(khan, [line(pad, "1000")]));
    const mine = and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, big.id));
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.update(salesDocuments).set({ exchangeRate: "0.00000001", updatedBy: userIds.salesperson }).where(mine)))).toBe("SE052");
    // What only FBR or an approval may write does not survive on a draft.
    await withTenant(userIds.salesperson, tenantA, (tx) => tx.execute(sql`update public.sales_documents set credit_limit = 1, credit_exposure = 1, buyer_address = 'planted', updated_by = ${userIds.salesperson} where id = ${big.id}`));
    expect((await admin`select credit_limit, credit_exposure, buyer_address, fbr_status, offline_flag from public.sales_documents where id = ${big.id}`)[0]).toEqual({ credit_limit: null, credit_exposure: null, buyer_address: null, fbr_status: null, offline_flag: false });
    const [planted] = await withTenant(userIds.salesperson, tenantA, (tx) => tx.execute<{ id: string }>(sql`insert into public.sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, taxed, prices_include_tax, fbr_invoice_number, fbr_status, offline_flag, credit_limit, created_by, updated_by)
      values (${tenantA}, 'order', ${D}, ${khan}, ${mainWarehouse}, ${mainBranch}, 'PKR', false, false, 'FBR-FAKE-1', 'accepted', true, 5, ${userIds.salesperson}, ${userIds.salesperson}) returning id`));
    expect((await admin`select fbr_invoice_number, fbr_status, offline_flag, credit_limit from public.sales_documents where id = ${planted.id}`)[0]).toEqual({ fbr_invoice_number: null, fbr_status: null, offline_flag: false, credit_limit: null });
    await discardSalesDraft(as.salesperson, planted.id);

    // A transaction that reads an older picture of the database is not let near a sales document:
    // its checks would not see a line or an order committed after it began.
    const submitting = { status: "submitted", submittedBy: userIds.salesperson, updatedBy: userIds.salesperson };
    const old = (run: (tx: Parameters<Parameters<ReturnType<typeof getConnection>["db"]["transaction"]>[0]>[0]) => Promise<unknown>) =>
      codeOf(() =>
        getConnection().db.transaction(
          async (tx) => {
            await tx.execute(sql`select set_config('app.user_id', ${userIds.salesperson}, true), set_config('app.tenant_id', ${tenantA}, true)`);
            await run(tx);
          },
          { isolationLevel: "repeatable read" },
        ),
      );
    expect(await old((tx) => tx.update(salesDocuments).set(submitting).where(mine))).toBe("SE056");
    expect(await old((tx) => tx.delete(salesLines).where(and(eq(salesLines.tenantId, tenantA), eq(salesLines.documentId, big.id))))).toBe("SE056");
    expect(await old((tx) => tx.insert(salesDocuments).values(draft))).toBe("SE056");
    expect((await getSalesDocument(as.salesperson, big.id))!.status).toBe("draft");
    await discardSalesDraft(as.salesperson, big.id);

    // A date with no open fiscal period is refused, through the app and past it; no number is spent.
    const early = await saveSalesDraft(as.salesperson, null, quotation(city, [line(pad, "1")], { date: "2026-06-30" }));
    await expect(submitSalesDocument(as.salesperson, early.id)).rejects.toThrow("No fiscal period is open for 30-06-2026.");
    expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.update(salesDocuments).set({ ...submitting, number: "QT-2526-00001" }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, early.id)))))).toBe("SE001");
    await discardSalesDraft(as.salesperson, early.id);

    // A submitted order keeps its lines, shares and links as they are, whoever asks.
    const done = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "2")], { shares: [{ userId: userIds.salesperson, percent: "100" }] }));
    const other = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "1")]));
    const { number } = (await submitSalesDocument(as.sales_manager, done.id)) as { number: string };
    const [{ id: lineId }] = (await getSalesDocument(as.owner, done.id))!.lines;
    const owner = <T>(run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => codeOf(() => withTenant(userIds.owner, tenantA, run));
    expect(await owner((tx) => tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, unit_price, value, total, created_by) values (${tenantA}, ${done.id}, 2, ${pad}, 'Late', ${piece}, 1, 1, 110, 110, 110, ${userIds.owner})`))).toBe("SE050");
    expect(await owner((tx) => tx.delete(salesLineSalespeople).where(and(eq(salesLineSalespeople.tenantId, tenantA), eq(salesLineSalespeople.documentId, done.id))))).toBe("SE050");
    expect(await owner((tx) => tx.insert(salesLineSalespeople).values({ tenantId: tenantA, documentId: done.id, lineId, userId: seller2, sharePercent: "50", createdBy: userIds.owner }))).toBe("SE050");
    expect(await owner((tx) => tx.insert(salesDocumentLinks).values({ tenantId: tenantA, fromDocumentId: other.id, toDocumentId: done.id, createdBy: userIds.owner }))).toBe("SE050");
    // The database refuses a cancel with no reason; the number stays with the order.
    expect(await owner((tx) => tx.update(salesDocuments).set({ status: "cancelled", cancelledBy: userIds.owner, updatedBy: userIds.owner }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, done.id))))).toBe("23514");
    expect(await getSalesDocument(as.owner, done.id)).toMatchObject({ status: "submitted", number });

    // A share that belonged to someone who has since left the sales team stops the submit.
    await saveSalesDraft(as.sales_manager, other.id, order(city, [line(pad, "1")], { shares: [{ userId: seller2, percent: "100" }] }));
    await admin`update public.memberships set active = false where tenant_id = ${tenantA} and user_id = ${seller2}`;
    await expect(submitSalesDocument(as.sales_manager, other.id)).rejects.toThrow("Salespeople: choose an active owner, sales manager or salesperson of this company.");
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ status: "submitted", submittedBy: userIds.sales_manager, updatedBy: userIds.sales_manager }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, other.id)))))).toBe("SE052");
    await admin`update public.memberships set active = true where tenant_id = ${tenantA} and user_id = ${seller2}`;
    await discardSalesDraft(as.sales_manager, other.id);

    // The price lists move after a draft was saved at their price: it is not submitted at the old one.
    const listed = await saveSalesDraft(as.salesperson, null, order(city, [line(pad, "3")]));
    await setCustomerPrice(as.owner, { item: pad, customer: city, price: "90", validFrom: "2026-11-10", validTo: "" });
    await expect(submitSalesDocument(as.salesperson, listed.id)).rejects.toThrow("A price or a tax rate has changed since this draft was saved. Check it and save it again.");
    await saveSalesDraft(as.salesperson, listed.id, order(city, [line(pad, "3")]));
    expect((await getSalesDocument(as.salesperson, listed.id))!.lines.map(figures)).toEqual(["3 @ 90.00 - 0.00 = 270.00 + 0.00 + 0.00 = 270.00"]);
    expect(await submitSalesDocument(as.salesperson, listed.id)).toMatchObject({ status: "submitted" });

    // A statement that slips into another company halfway, where its author is an owner, gains nothing:
    // the guards ask who is writing for every row. First the credit limit, by an accountant.
    const before = (await admin`select credit_limit::text from public.customers where id = ${khan}`)[0].credit_limit;
    const lifted = await codeOf(() =>
      withTenant(userIds.accountant, tenantA, async (tx) => {
        await tx.execute(sql`update public.customers set updated_by = ${userIds.accountant} where id = ${khan}`);
        await tx.execute(sql`update public.customers c set updated_by = ${userIds.accountant},
          credit_limit = case when c.id = ${khan} then 900000000 + length(set_config('app.tenant_id', ${tenantB}, true)) else c.credit_limit end
          where c.id in (${city}, ${khan})`);
      }),
    );
    expect(["42501", "SE055"]).toContain(lifted);
    expect((await admin`select credit_limit::text from public.customers where id = ${khan}`)[0].credit_limit).toBe(before);
    // Then another salesperson's draft, re-filed under one's own name.
    const theirs = await saveSalesDraft(as.salesperson, null, order(city, [line(pad, "1")]));
    const refiled = await codeOf(() =>
      withTenant(seller2, tenantA, async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_hashjoin = off`);
        await tx.execute(sql`set local enable_mergejoin = off`);
        await tx.execute(sql`set local enable_material = off`);
        await tx.execute(sql`update public.sales_documents d set updated_by = ${seller2}, salesperson_id = ${seller2}::uuid, notes = 'mine' || left(set_config('app.tenant_id', ${tenantA}, true), 0)
          from (select * from (values (1, '00000000-0000-4000-8000-000000000000'::uuid, ''), (2, ${theirs.id}::uuid, set_config('app.tenant_id', ${tenantB}, true))) v(o, id, x) offset 0) v
          where d.tenant_id = ${tenantA} and d.id = v.id`);
      }),
    );
    expect([undefined, "42501"]).toContain(refiled);
    expect((await admin`select salesperson_id, notes from public.sales_documents where id = ${theirs.id}`)[0]).toEqual({ salesperson_id: null, notes: null });
    await discardSalesDraft(as.salesperson, theirs.id);

    // The rows the database writes itself cannot be imitated, and no row chooses its own time.
    const fake = { tenantId: tenantA, actorUserId: userIds.salesperson, actorRole: "salesperson" as const, entity: "sales_document", entityId: done.id };
    for (const action of ["sales_order.credit_override", "sales_order.submit", "sales_quotation.cancel", "journal.post", "customer.credit_limit"]) {
      expect(await codeOf(() => withTenant(userIds.salesperson, tenantA, (tx) => tx.insert(auditLog).values({ ...fake, action }))), action).toBe("42501");
    }
    await withTenant(userIds.salesperson, tenantA, (tx) => tx.insert(auditLog).values({ ...fake, action: "sales_order.note", at: new Date("2020-01-01T00:00:00Z") }));
    expect((await admin`select (at > now() - interval '1 minute') as fresh from public.audit_log where entity_id = ${done.id} and action = 'sales_order.note'`)[0].fresh).toBe(true);
    // The owner's change of a limit is in the log however it is made.
    await withTenant(userIds.owner, tenantA, (tx) => tx.update(customers).set({ creditLimit: "60000", updatedBy: userIds.owner }).where(and(eq(customers.tenantId, tenantA), eq(customers.id, khan))));
    expect((await auditOf(khan, "customer.credit_limit")).at(-1)).toMatchObject({ actor_role: "owner", before: { name: "Khan Autos", creditLimit: "50000.0000" }, after: { creditLimit: "60000.0000" } });
    await withTenant(userIds.owner, tenantA, (tx) => tx.update(customers).set({ creditLimit: "50000", updatedBy: userIds.owner }).where(and(eq(customers.tenantId, tenantA), eq(customers.id, khan))));

    // Whether a document carries sales tax is the company's answer, not the writer's.
    const flagged = await saveSalesDraft(as.sales_manager, null, order(city, [line(pad, "1")]));
    await withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ taxed: true, updatedBy: userIds.sales_manager }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, flagged.id))));
    expect(await codeOf(() => withTenant(userIds.sales_manager, tenantA, (tx) => tx.update(salesDocuments).set({ status: "submitted", submittedBy: userIds.sales_manager, updatedBy: userIds.sales_manager }).where(and(eq(salesDocuments.tenantId, tenantA), eq(salesDocuments.id, flagged.id)))))).toBe("SE052");
    await discardSalesDraft(as.sales_manager, flagged.id);
  });

  it("works out sales tax and further tax for a registered company, and refuses figures that have gone stale", async () => {
    const each = (await addUnit(registered, { code: "pc", name: "Piece" })).id;
    const helmet = (await createItem(registered, { code: "HL-1", name: "Helmet", unit: each, defaultPrice: "1000" })).id;
    const walkIn = (await createParty(registered, "customer", { name: "Walk-in Rider" })).id;
    const dealer = (await createParty(registered, "customer", { name: "Registered Dealer", registrationType: "registered", ntn: "1234567", strn: "3277876123456", atlStatus: "active" })).id;
    const sale = (customerId: string): RawDocument => ({ kind: "order", date: D, customerId, warehouseId: warehouseR, lines: [line(helmet, "2")] });

    // An unregistered buyer pays 18% sales tax and 4% further tax on top of the price.
    const toRider = await saveSalesDraft(registered, null, sale(walkIn));
    const rider = await getSalesDocument(registered, toRider.id);
    expect(rider).toMatchObject({ taxed: true, pricesIncludeTax: false });
    expect(rider!.lines.map((l) => `${figures(l)} | ${l.taxKind} ${l.taxRate.toFixed()}% further ${l.furtherTaxRate.toFixed()}% ${l.furtherTaxReason}`)).toEqual(["2 @ 1000.00 - 0.00 = 2000.00 + 360.00 + 80.00 = 2440.00 | standard 18% further 4% buyer_unregistered"]);
    expect(`${rider!.totals.value.toFixed(2)} ${rider!.totals.tax.toFixed(2)} ${rider!.totals.furtherTax.toFixed(2)} ${rider!.totals.total.toFixed(2)}`).toBe("2000.00 360.00 80.00 2440.00");
    // A registered, active buyer pays the sales tax only.
    const toDealer = await saveSalesDraft(registered, null, sale(dealer));
    expect((await getSalesDocument(registered, toDealer.id))!.lines.map(figures)).toEqual(["2 @ 1000.00 - 0.00 = 2000.00 + 360.00 + 0.00 = 2360.00"]);
    expect(await submitSalesDocument(registered, toDealer.id)).toMatchObject({ status: "submitted" });
    expect((await admin`select buyer_ntn, buyer_strn, buyer_registration_type, buyer_atl_status from public.sales_documents where id = ${toDealer.id}`)[0]).toEqual({ buyer_ntn: "1234567", buyer_strn: "3277876123456", buyer_registration_type: "registered", buyer_atl_status: "active" });

    // The rate changes after the draft was saved: what was saved is no longer right, so it is not submitted.
    const [standard] = await admin<{ id: string }[]>`select id from public.tax_categories where tenant_id = ${tenantR} and kind = 'standard' order by created_at limit 1`;
    await setTaxRate(registered, { categoryId: standard.id, effectiveFrom: "2026-11-01", rate: "17", furtherTaxRate: "4", legalReference: "Test change of rate" });
    await expect(submitSalesDocument(registered, toRider.id)).rejects.toThrow("A price or a tax rate has changed since this draft was saved. Check it and save it again.");
    await saveSalesDraft(registered, toRider.id, sale(walkIn));
    expect((await getSalesDocument(registered, toRider.id))!.lines.map(figures)).toEqual(["2 @ 1000.00 - 0.00 = 2000.00 + 340.00 + 80.00 = 2420.00"]);
    expect(await submitSalesDocument(registered, toRider.id)).toMatchObject({ status: "submitted" });

    // A registered company cannot submit a document that says it carries no tax.
    const hidden = await saveSalesDraft(registered, null, sale(dealer));
    const its = and(eq(salesDocuments.tenantId, tenantR), eq(salesDocuments.id, hidden.id));
    await withTenant(ownerR, tenantR, async (tx) => {
      await tx.execute(sql`delete from public.sales_lines where document_id = ${hidden.id}`);
      await tx.execute(sql`insert into public.sales_lines (tenant_id, document_id, line_no, item_id, description, unit_id, quantity, base_quantity, unit_price, value, total, created_by) values (${tenantR}, ${hidden.id}, 1, ${helmet}, 'Helmet', ${each}, 2, 2, 1000, 2000, 2000, ${ownerR})`);
      await tx.update(salesDocuments).set({ taxed: false, taxTotal: "0", total: "2000", updatedBy: ownerR }).where(its);
    });
    expect(await codeOf(() => withTenant(ownerR, tenantR, (tx) => tx.update(salesDocuments).set({ status: "submitted", submittedBy: ownerR, updatedBy: ownerR }).where(its)))).toBe("SE052");
    await discardSalesDraft(registered, hidden.id);

    // The same company with the tax inside its prices: the price is what the buyer pays.
    await admin`update public.company_setup set prices_include_tax = true where tenant_id = ${tenantR}`;
    const inside = await saveSalesDraft(registered, null, { kind: "order", date: D, customerId: dealer, warehouseId: warehouseR, lines: [line(helmet, "1", { unitPrice: "1170", discountPercent: "10" })] });
    const document = await getSalesDocument(registered, inside.id);
    expect(document).toMatchObject({ taxed: true, pricesIncludeTax: true });
    expect(document!.lines.map(figures)).toEqual(["1 @ 1170.00 - 117.00 = 900.00 + 153.00 + 0.00 = 1053.00"]);
    expect(await submitSalesDocument(registered, inside.id)).toMatchObject({ status: "submitted" });
  });
});
