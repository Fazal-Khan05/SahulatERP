import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant, type Tx } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem, setItemUnit } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty, setPartyArchived, updateParty } from "@/modules/parties/commands";
import { postReceiptIn, saveOrderDraft, saveOrderDraftIn, saveReceiptDraftIn, submitOrder, submitOrderIn } from "@/modules/purchasing/commands";
import { getOrderChoices, selectLinesToReceive } from "@/modules/purchasing/queries";
import { postDelivery, saveSalesDraft, startDelivery, submitSalesDocument } from "@/modules/sales/commands";
import { getDeliveryRows, getSalesDocument } from "@/modules/sales/queries";
import { postBill, postBillIn, saveBillDraft, saveBillDraftIn } from "@/modules/supplier-bills/commands";
import { selectReceiptLinesToBill } from "@/modules/supplier-bills/queries";
import { cancelPayment, postPayment, postPaymentIn, savePaymentDraft, savePaymentDraftIn } from "@/modules/supplier-payments/commands";
import { listBillsOwed } from "@/modules/supplier-payments/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { postMarketPurchase } from "./commands";
import { getMarketPurchaseChoices, getMarketPurchaseOfBill } from "./queries";
import { shortages } from "./rules";

// A quick market purchase against a real database, through the app's own path (app_runtime,
// withTenant, row-level security): it makes the order, the goods received note, the bill and
// the payment at once and leaves the books as a slow purchase would; the market seller is
// bought from in no other way and is never owed anything by it; and the reason it exists, a
// delivery that was short goes through once the goods are bought. Skipped when the database
// URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-market-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const northWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@market.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const OPENED = "2026-10-01";
const DAY = "2026-11-20";

let admin: AdminSql;
let helmet: string;
let carton: string;
let cash: string;
let bank: string;
let wholesaler: string;
let dealer: string;

/** The database's code for what this member's work was refused with, or undefined when it went through. */
async function refusedWith(who: TenantContext, work: (tx: Tx) => Promise<unknown>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, work);
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const codeOf = (who: TenantContext, statement: ReturnType<typeof sql>) => refusedWith(who, (tx) => tx.execute(statement));
const line = (quantity: string, unitCost: string, unitId = "") => ({ itemId: helmet, unitId, quantity, unitCost });
const purchase = (over: Record<string, unknown> = {}) => ({ date: DAY, warehouseId: mainWarehouse, sellerKind: "market", sellerName: "Anarkali Helmet House", sellerPhone: "0300 1234567", lines: [line("4", "650")], method: "cash", accountId: cash, ...over });
const journalOf = async (sourceType: string, sourceId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text || coalesce(' (' || s.name || ')', '') as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id left join public.suppliers s on s.id = l.supplier_id
      where j.tenant_id = ${tenantA} and j.source_id = ${sourceId} and j.source_type = ${sourceType} order by l.line_no`
  ).map((row) => row.line);
/** The balance of a locked account as a liability: credit less debit. */
const balance = async (control: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = ${control}`
  )[0].v;
const stock = async (warehouseId = mainWarehouse) =>
  (await admin<{ v: string }[]>`select trim_scale(quantity)::text || ' worth ' || trim_scale(value)::text as v from public.stock_balances where tenant_id = ${tenantA} and item_id = ${helmet} and warehouse_id = ${warehouseId}`)[0]?.v ?? "none";
const counts = async () =>
  (
    await admin<{ v: string }[]>`
      select (select count(*) from public.purchase_orders where tenant_id = ${tenantA})::text || ' orders, '
        || (select count(*) from public.goods_receipts where tenant_id = ${tenantA})::text || ' notes, '
        || (select count(*) from public.supplier_bills where tenant_id = ${tenantA})::text || ' bills, '
        || (select count(*) from public.supplier_payments where tenant_id = ${tenantA})::text || ' payments, '
        || (select count(*) from public.market_purchases where tenant_id = ${tenantA})::text || ' market purchases, '
        || (select count(*) from public.journals where tenant_id = ${tenantA})::text || ' journals' as v`
  )[0].v;
const marketSupplier = async () => (await admin<{ id: string }[]>`select supplier_id as id from public.market_suppliers where tenant_id = ${tenantA}`)[0]?.id;
const idsOf = async (id: string) => (await admin<{ order_id: string; receipt_id: string; bill_id: string; payment_id: string }[]>`select order_id, receipt_id, bill_id, payment_id from public.market_purchases where id = ${id}`)[0];

/**
 * A quick market purchase made by hand, past postMarketPurchase, as far as `upTo` and then
 * committed: to show the database itself refuses one left without its bill, unpaid, paid in
 * part, or with only some of the goods in.
 */
async function byHand(upTo: "received" | "billed" | "part-paid" | "part-received"): Promise<string | undefined> {
  return refusedWith(as.owner, async (tx) => {
    const [market] = await tx.execute<{ id: string }>(sql`select app.market_supplier() as id`);
    const order = await saveOrderDraftIn(tx, as.owner, null, { date: DAY, supplierId: market.id, warehouseId: mainWarehouse, expectedOn: null, supplierReference: null, note: null, lines: [{ itemId: helmet, unitId: null, quantity: new Decimal(2), unitCost: new Decimal(100), description: null }] });
    await tx.execute(sql`insert into public.market_purchases (tenant_id, order_id, seller_name, client_key, created_by) values (${tenantA}, ${order.id}, 'By Hand', gen_random_uuid(), ${userIds.owner})`);
    await submitOrderIn(tx, as.owner, order.id);
    const lines = await selectLinesToReceive(tx, order.id);
    const note = await saveReceiptDraftIn(tx, as.owner, null, order.id, { date: DAY, supplierDeliveryNote: null, note: null, lines: lines.map((l) => ({ orderLineId: l.lineId, quantity: upTo === "part-received" ? new Decimal(1) : l.ordered })) });
    await tx.execute(sql`update public.market_purchases set receipt_id = ${note.id} where order_id = ${order.id}`);
    const received = await postReceiptIn(tx, as.owner, note.id);
    if (upTo === "received") return;
    const toBill = (await selectReceiptLinesToBill(tx, tenantA, market.id, mainBranch)).filter((l) => l.receiptNumber === received.number);
    const bill = await saveBillDraftIn(tx, as.owner, null, { date: DAY, supplierId: market.id, branchId: mainBranch, supplierInvoiceNo: `HAND-${randomUUID().slice(0, 8)}`, dueDate: null, note: null, incomeTaxCode: null, salesTaxCode: null, provincialTaxCode: null, goods: toBill.map((l) => ({ receiptLineId: l.receiptLineId, quantity: l.received, unitPrice: l.orderCost, taxCategoryId: null })), expenses: [] });
    await tx.execute(sql`update public.market_purchases set bill_id = ${bill.id} where order_id = ${order.id}`);
    await postBillIn(tx, as.owner, bill.id);
    if (upTo === "billed") return;
    const amount = new Decimal(upTo === "part-paid" ? 150 : upTo === "part-received" ? 100 : 200);
    const pay = await savePaymentDraftIn(tx, as.owner, null, { date: DAY, supplierId: market.id, branchId: mainBranch, accountId: cash, reference: null, note: null, amount, foreign: null, allocations: [{ billId: bill.id, amount }] });
    await tx.execute(sql`update public.market_purchases set payment_id = ${pay.id} where order_id = ${order.id}`);
    await postPaymentIn(tx, as.owner, pay.id);
  });
}

describe.skipIf(!hasDb)("quick market purchases", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner}), (${northWarehouse}, ${tenantA}, ${northBranch}, 'North store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    cash = await account("1111");
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    carton = (await addUnit(as.owner, { code: "ctn", name: "Carton" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    await setItemUnit(as.owner, helmet, { unit: carton, factor: "10" });
    wholesaler = (await createParty(as.owner, "supplier", { name: "Lahore Wholesalers", code: "S-001" })).id;
    // A supplier already called what the market supplier would be called: the market supplier takes the next name.
    await createParty(as.owner, "supplier", { name: "Market seller", code: "S-002" });
    dealer = (await createParty(as.owner, "customer", { name: "Karachi Dealer", code: "C-001", creditDays: "30" })).id;
    const opening = await saveAdjustmentDraft(as.owner, "opening", null, { date: OPENED, warehouseId: mainWarehouse, lines: [{ itemCode: "HL-1", direction: "in", quantity: "5", unitCost: "600" }] });
    await postAdjustment(as.owner, opening.id);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("makes the order, the goods received note, the bill and the payment at once: the goods are in stock at what they cost and nothing is owed", async () => {
    expect(await stock()).toBe("5 worth 3000");
    const made = await postMarketPurchase(as.owner, purchase({ memoNo: "CM-118", note: "For the Karachi order" }));
    expect(made).toMatchObject({ orderNumber: "PO-2627-00001", receiptNumber: "GR-2627-00001", total: "2600.00" });
    expect(made.billNumber).toMatch(/-2627-00001$/);
    expect(made.paymentNumber).toMatch(/-2627-00001$/);
    const supplier = await marketSupplier();
    expect((await admin<{ name: string; registration_type: string; supplier_type: string }[]>`select name, registration_type::text, supplier_type::text from public.suppliers where id = ${supplier}`)[0]).toEqual({ name: "Market seller 2", registration_type: "unregistered", supplier_type: "individual" });

    // In stock at once, at the price paid: 5 at 600 and 4 at 650.
    expect(await stock()).toBe("9 worth 5600");
    const ids = await idsOf(made.id);
    expect(ids.order_id).toBe(made.orderId);
    expect(ids.bill_id).toBe(made.billId);
    // The books, as a slow purchase leaves them: goods in against goods received not billed, the bill clears that, the payment clears the bill.
    expect(await journalOf("goods_receipt", ids.receipt_id)).toEqual(["1300 Stock in trade: 2600 / 0", "2120 Goods received not invoiced: 0 / 2600"]);
    expect(await journalOf("supplier_bill", ids.bill_id)).toEqual(["2120 Goods received not invoiced: 2600 / 0", "2110 Trade payables: 0 / 2600 (Market seller 2)"]);
    expect(await journalOf("supplier_payment", ids.payment_id)).toEqual(["2110 Trade payables: 2600 / 0 (Market seller 2)", "1111 Cash in hand: 0 / 2600"]);
    expect([await balance("ap"), await balance("grni")]).toEqual(["0.00", "0.00"]);
    expect(await listBillsOwed(as.accountant, supplier, mainBranch)).toEqual([]);

    // Each document says where it came from and who sold; the bill carries the order's number, which no other bill has.
    const [bill] = await admin<{ supplier_invoice_no: string; note: string; status: string; total: string; withheld: string; sales_tax: string }[]>`
      select supplier_invoice_no, note, status, total::text, withheld::text, sales_tax::text from public.supplier_bills where id = ${ids.bill_id}`;
    expect(bill).toEqual({ supplier_invoice_no: "PO-2627-00001", note: "Quick market purchase from Anarkali Helmet House (0300 1234567), cash memo CM-118. For the Karachi order", status: "posted", total: "2600.00", withheld: "0.00", sales_tax: "0.00" });
    const [row] = await admin<{ seller_name: string; seller_phone: string; memo_no: string }[]>`select seller_name, seller_phone, memo_no from public.market_purchases where id = ${made.id}`;
    expect(row).toEqual({ seller_name: "Anarkali Helmet House", seller_phone: "0300 1234567", memo_no: "CM-118" });
    expect(await getMarketPurchaseOfBill(as.auditor, made.billId)).toMatchObject({ sellerName: "Anarkali Helmet House", orderNumber: "PO-2627-00001", receiptNumber: "GR-2627-00001", paymentNumber: made.paymentNumber, method: "cash" });
    const [audit] = await admin<{ actor_role: string; after: Record<string, unknown> }[]>`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'market_purchase.post'`;
    expect(audit.actor_role).toBe("owner");
    expect(audit.after).toMatchObject({ seller: "Anarkali Helmet House", onTheList: false, order: "PO-2627-00001", goodsReceived: "GR-2627-00001", total: "2600.00", paidBy: "cash" });
    // Every document it made wrote its own audit rows too, as it does anywhere else.
    const actions = (await admin<{ action: string }[]>`select distinct action from public.audit_log where tenant_id = ${tenantA} and action like any (array['purchase_order.%', 'goods_receipt.%', 'supplier_bill.%', 'supplier_payment.%'])`).map((r) => r.action).sort();
    expect(actions).toEqual(["goods_receipt.create", "goods_receipt.post", "purchase_order.create", "purchase_order.submit", "supplier_bill.create", "supplier_bill.post", "supplier_payment.create", "supplier_payment.post"]);
  });

  it("buys from a supplier on the list, by the carton, out of the bank; and uses the same market supplier every time", async () => {
    const made = await postMarketPurchase(as.accountant, purchase({ sellerKind: "supplier", supplierId: wholesaler, sellerName: "ignored", memoNo: "INV-77", lines: [line("2", "6200", carton)], method: "bank", accountId: bank, reference: "Chq 4411" }));
    expect(made).toMatchObject({ orderNumber: "PO-2627-00002", receiptNumber: "GR-2627-00002", total: "12400.00" });
    // Two cartons of ten at 6,200 a carton: twenty helmets at 620.
    expect(await stock()).toBe("29 worth 18000");
    const ids = await idsOf(made.id);
    expect(await journalOf("supplier_payment", ids.payment_id)).toEqual(["2110 Trade payables: 12400 / 0 (Lahore Wholesalers)", "1121 HBL current account: 0 / 12400"]);
    const [bill] = await admin<{ supplier_invoice_no: string; supplier_id: string }[]>`select supplier_invoice_no, supplier_id from public.supplier_bills where id = ${ids.bill_id}`;
    expect(bill).toEqual({ supplier_invoice_no: "INV-77", supplier_id: wholesaler });
    const [row] = await admin<{ seller_name: string | null; memo_no: string }[]>`select seller_name, memo_no from public.market_purchases where id = ${made.id}`;
    expect(row).toEqual({ seller_name: null, memo_no: "INV-77" });
    expect((await admin<{ reference: string }[]>`select reference from public.supplier_payments where id = ${ids.payment_id}`)[0].reference).toBe("Chq 4411");
    // The same invoice of the same supplier entered again is caught, as on any bill.
    await expect(postMarketPurchase(as.accountant, purchase({ sellerKind: "supplier", supplierId: wholesaler, memoNo: "inv-77" }))).rejects.toThrow("already been posted");

    const before = await marketSupplier();
    await postMarketPurchase(as.accountant, purchase({ sellerName: "  Shah   Alam Traders ", sellerPhone: "", lines: [line("1", "700")] }));
    expect(await marketSupplier()).toBe(before);
    expect((await admin<{ n: number }[]>`select count(*)::int as n from public.market_suppliers where tenant_id = ${tenantA}`)[0].n).toBe(1);
    expect((await admin<{ seller_name: string; seller_phone: string | null }[]>`select seller_name, seller_phone from public.market_purchases where tenant_id = ${tenantA} order by created_at desc limit 1`)[0]).toEqual({ seller_name: "Shah Alam Traders", seller_phone: null });
    expect([await balance("ap"), await balance("grni")]).toEqual(["0.00", "0.00"]);
    // The market supplier is not offered where an ordinary order chooses its supplier, and the purchase's own list leaves it out too.
    expect((await getOrderChoices(as.owner)).suppliers.map((s) => s.label)).toEqual(["Lahore Wholesalers (S-001)", "Market seller (S-002)"]);
    const choices = await getMarketPurchaseChoices(as.owner);
    expect(choices.suppliers.map((s) => s.label)).toEqual(["Lahore Wholesalers (S-001)", "Market seller (S-002)"]);
    expect(choices.accounts.map((a) => `${a.kind} ${a.label}`)).toEqual(["cash 1111 Cash in hand", "bank 1121 HBL current account"]);
    expect(choices.withholds).toBe(false);
  });

  it("makes nothing when any part of it is refused, and takes no number", async () => {
    const before = await counts();
    const stockBefore = await stock();
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
    await expect(postMarketPurchase(as.owner, purchase({ date: tomorrow }))).rejects.toThrow("never before it");
    // The order itself would go through on that day; the goods cannot come in before the books were opened.
    await expect(postMarketPurchase(as.owner, purchase({ date: "2026-06-15" }))).rejects.toThrow();
    await expect(postMarketPurchase(as.owner, purchase({ method: "cash", accountId: bank }))).rejects.toThrow("Choose the cash account");
    await expect(postMarketPurchase(as.owner, purchase({ method: "bank", accountId: cash }))).rejects.toThrow("Choose the bank account");
    await expect(postMarketPurchase(as.owner, purchase({ lines: [line("4", "0")] }))).rejects.toThrow("more than zero");
    await expect(postMarketPurchase(as.owner, purchase({ lines: [] }))).rejects.toThrow("Enter at least one line");
    await expect(postMarketPurchase(as.owner, purchase({ lines: [line("1", "10"), line("2", "10")] }))).rejects.toThrow("twice in the same unit");
    await expect(postMarketPurchase(as.owner, purchase({ sellerName: "" }))).rejects.toThrow("Enter the seller's name");
    await expect(postMarketPurchase(as.owner, purchase({ sellerPhone: "call me" }))).rejects.toThrow("seller's phone");
    await expect(postMarketPurchase(as.owner, purchase({ sellerKind: "supplier", supplierId: randomUUID() }))).rejects.toThrow("Choose the supplier from the list");
    await expect(postMarketPurchase(as.owner, purchase({ sellerKind: "supplier", supplierId: await marketSupplier() }))).rejects.toThrow("A seller in the market");
    await expect(postMarketPurchase(as.owner, purchase({ warehouseId: randomUUID() }))).rejects.toThrow("Choose the warehouse");
    await expect(postMarketPurchase(as.owner, purchase({ lines: [{ itemId: randomUUID(), unitId: "", quantity: "1", unitCost: "5" }] }))).rejects.toThrow("choose an item from the list");
    expect(await counts()).toBe(before);
    expect(await stock()).toBe(stockBefore);
    // No number was taken by anything refused: the next purchase follows the last one.
    const next = await postMarketPurchase(as.owner, purchase({ lines: [line("1", "640")] }));
    expect([next.orderNumber, next.receiptNumber]).toEqual(["PO-2627-00004", "GR-2627-00004"]);
  });

  it("records a purchase sent twice once", async () => {
    const clientKey = randomUUID();
    const before = await counts();
    const first = await postMarketPurchase(as.owner, purchase({ clientKey, lines: [line("1", "600")] }));
    const again = await postMarketPurchase(as.owner, purchase({ clientKey, lines: [line("1", "600")] }));
    expect(again).toEqual(first);
    const [both, alone] = await Promise.all([postMarketPurchase(as.owner, purchase({ clientKey, lines: [line("1", "600")] })), counts()]);
    expect(both).toEqual(first);
    expect(alone).not.toBe(before);
    expect((await admin<{ n: number }[]>`select count(*)::int as n from public.market_purchases where tenant_id = ${tenantA} and client_key = ${clientKey}`)[0].n).toBe(1);
  });

  it("is for the owner and an accountant, each in their own branches", async () => {
    for (const role of ["auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(postMarketPurchase(as[role], purchase())).rejects.toThrow("Only the owner or an accountant makes a quick market purchase");
      await expect(getMarketPurchaseChoices(as[role])).rejects.toThrow("Only the owner or an accountant");
    }
    // An accountant of the North branch does not see the Main store, and buys into the North store.
    await expect(postMarketPurchase(north, purchase())).rejects.toThrow("Choose the warehouse");
    expect((await getMarketPurchaseChoices(north)).warehouses.map((w) => w.label)).toEqual(["North store"]);
    const made = await postMarketPurchase(north, purchase({ warehouseId: northWarehouse, lines: [line("3", "610")] }));
    expect(await stock(northWarehouse)).toBe("3 worth 1830");
    const ids = await idsOf(made.id);
    expect((await admin<{ b: string; p: string }[]>`select (select branch_id from public.supplier_bills where id = ${ids.bill_id}) as b, (select branch_id from public.supplier_payments where id = ${ids.payment_id}) as p`)[0]).toEqual({ b: northBranch, p: northBranch });
    // Who reads a market purchase is who reads its order: not the warehouse or the sales team, not another branch's accountant, not another company.
    const visible = async (who: TenantContext, id: string) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute(sql`select 1 from public.market_purchases where id = ${id}`))).length;
    const [mainOne] = await admin<{ id: string }[]>`select m.id from public.market_purchases m join public.purchase_orders o on o.id = m.order_id where m.tenant_id = ${tenantA} and o.warehouse_id = ${mainWarehouse} limit 1`;
    expect([await visible(as.owner, made.id), await visible(as.auditor, made.id), await visible(north, made.id)]).toEqual([1, 1, 1]);
    expect([await visible(north, mainOne.id), await visible(as.warehouse_manager, made.id), await visible(as.salesperson, made.id), await visible(otherOwner, made.id)]).toEqual([0, 0, 0, 0]);
    expect(await getMarketPurchaseOfBill(as.warehouse_manager, made.billId).catch(() => null)).toBeNull();
    // Only those two roles can name the market supplier, or write the row.
    expect(await codeOf(as.salesperson, sql`select app.market_supplier()`)).toBe("42501");
    const draft = await saveOrderDraft(as.owner, null, { date: DAY, supplierId: wholesaler, warehouseId: mainWarehouse, lines: [line("1", "500")] });
    for (const role of ["warehouse_manager", "auditor", "salesperson"] as const) {
      expect(await codeOf(as[role], sql`insert into public.market_purchases (tenant_id, order_id, client_key, created_by) values (${tenantA}, ${draft.id}, gen_random_uuid(), ${userIds[role]})`)).toBe("42501");
    }
  });

  it("the database keeps a market purchase whole, written once", async () => {
    const before = await counts();
    // Left with the goods in and no bill, with the bill unpaid, paid in part, or with only some of the goods in: refused as the transaction ends.
    expect(await byHand("received")).toBe("SE268");
    expect(await byHand("billed")).toBe("SE268");
    expect(await byHand("part-paid")).toBe("SE268");
    expect(await byHand("part-received")).toBe("SE268");
    expect(await counts()).toBe(before);

    const [made] = await admin<{ id: string; order_id: string; bill_id: string; payment_id: string }[]>`select id, order_id, bill_id, payment_id from public.market_purchases where tenant_id = ${tenantA} order by created_at limit 1`;
    expect(await codeOf(as.owner, sql`delete from public.market_purchases where id = ${made.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.market_purchases set seller_name = 'Someone Else' where id = ${made.id}`)).toBe("42501");
    const [other] = await admin<{ bill_id: string }[]>`select bill_id from public.market_purchases where tenant_id = ${tenantA} and id <> ${made.id} limit 1`;
    expect(await codeOf(as.owner, sql`update public.market_purchases set bill_id = ${other.bill_id} where id = ${made.id}`)).toBe("SE268");
    // A row for an order that is already submitted, a second row for the same order, a seller named for a supplier on the list.
    expect(await codeOf(as.owner, sql`insert into public.market_purchases (tenant_id, order_id, seller_name, client_key, created_by) values (${tenantA}, ${made.order_id}, 'Late', gen_random_uuid(), ${userIds.owner})`)).toBe("SE268");
    const draft = await saveOrderDraft(as.owner, null, { date: DAY, supplierId: wholesaler, warehouseId: mainWarehouse, lines: [line("1", "500")] });
    expect(await codeOf(as.owner, sql`insert into public.market_purchases (tenant_id, order_id, seller_name, client_key, created_by) values (${tenantA}, ${draft.id}, 'Not On The List', gen_random_uuid(), ${userIds.owner})`)).toBe("SE268");
    // Starting with its other documents already named, or as someone else.
    expect(await codeOf(as.owner, sql`insert into public.market_purchases (tenant_id, order_id, client_key, created_by) values (${tenantB}, ${draft.id}, gen_random_uuid(), ${userIds.owner})`)).toBe("42501");
  });

  it("the market seller is bought from in no other way, and stays what it is", async () => {
    const supplier = (await marketSupplier())!;
    // An ordinary order to the market supplier can be written, and is refused when it is submitted.
    const order = await saveOrderDraft(as.owner, null, { date: DAY, supplierId: supplier, warehouseId: mainWarehouse, lines: [line("1", "500")] });
    await expect(submitOrder(as.owner, order.id)).rejects.toThrow();
    expect(await codeOf(as.owner, sql`select app.submit_purchase_order(${order.id}::uuid)`)).toBe("SE267");
    // An expense billed in its name, which would leave money owed to nobody in particular.
    const rent = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '5230'`)[0].id;
    const bill = await saveBillDraft(as.accountant, null, { date: DAY, supplierId: supplier, branchId: mainBranch, supplierInvoiceNo: "X-1", expenses: [{ accountId: rent, description: "Rent", amount: "100" }] });
    await expect(postBill(as.accountant, bill.id)).rejects.toThrow();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_bill(${bill.id}::uuid)`)).toBe("SE267");
    expect(await balance("ap")).toBe("0.00");

    await expect(setPartyArchived(as.owner, "supplier", supplier, true)).rejects.toThrow();
    expect(await codeOf(as.owner, sql`update public.suppliers set archived_at = now(), archived_by = ${userIds.owner} where id = ${supplier}`)).toBe("SE269");
    expect(await codeOf(as.owner, sql`update public.suppliers set registration_type = 'registered', ntn = '1234567', strn = '1234567890123' where id = ${supplier}`)).toBe("SE269");
    expect(await codeOf(as.owner, sql`update public.suppliers set cnic = '1234567890123' where id = ${supplier}`)).toBe("SE269");
    // Renamed or given a code: yes.
    await updateParty(as.owner, "supplier", supplier, { name: "Bazaar sellers", code: "MKT" });
    expect((await admin<{ name: string }[]>`select name from public.suppliers where id = ${supplier}`)[0].name).toBe("Bazaar sellers");
    // An ordinary supplier is not held to any of this.
    await setPartyArchived(as.owner, "supplier", wholesaler, true);
    await setPartyArchived(as.owner, "supplier", wholesaler, false);
  });

  it("what comes after follows the documents' own rules: a payment entered by mistake is cancelled and paid again", async () => {
    const made = await postMarketPurchase(as.owner, purchase({ lines: [line("1", "660")] }));
    const ids = await idsOf(made.id);
    const supplier = (await marketSupplier())!;
    await cancelPayment(as.accountant, ids.payment_id, { date: DAY, reason: "Paid from the wrong account" });
    expect((await listBillsOwed(as.accountant, supplier, mainBranch)).map((b) => `${b.number}: ${b.owed.toFixed(2)}`)).toEqual([`${made.billNumber}: 660.00`]);
    const again = await savePaymentDraft(as.accountant, null, { date: DAY, supplierId: supplier, branchId: mainBranch, accountId: bank, amount: "660", allocations: [{ billId: ids.bill_id, amount: "660" }] });
    await postPayment(as.accountant, again.id);
    expect([await balance("ap"), await balance("grni")]).toEqual(["0.00", "0.00"]);
  });

  it("the reason it exists: a delivery that is short goes through once the goods are bought", async () => {
    // Sell everything the Main store holds and 6 more.
    const held = new Decimal((await stock()).split(" ")[0]);
    const wanted = held.plus(6);
    const order = await saveSalesDraft(as.owner, null, { kind: "order", date: DAY, validUntil: "", customerId: dealer, warehouseId: mainWarehouse, customerReference: "", notes: "", lines: [{ itemId: helmet, unitId: "", quantity: wanted.toFixed(), unitPrice: "", discountPercent: "" }], shares: [] });
    await submitSalesDocument(as.owner, order.id);
    const note = await startDelivery(as.warehouse_manager, order.id);
    await expect(postDelivery(as.warehouse_manager, note.id)).rejects.toThrow(`Not enough HL-1 in stock at Main store: ${held.toFixed()} on hand, ${wanted.toFixed()} needed`);

    // The delivery's page works out what is missing, item by item, for whoever may read the note; no cost is involved.
    const document = (await getSalesDocument(as.warehouse_manager, note.id))!;
    const short = shortages(await getDeliveryRows(as.warehouse_manager, document));
    expect(short.map((s) => `${s.itemCode}: ${s.short.toFixed()} short of ${s.needed.toFixed()} (${s.unitCode})`)).toEqual([`HL-1: 6 short of ${wanted.toFixed()} (pc)`]);

    // The warehouse cannot buy; the owner does, for exactly what is missing.
    await expect(postMarketPurchase(as.warehouse_manager, purchase({ lines: [line(short[0].short.toFixed(), "655")] }))).rejects.toThrow("Only the owner or an accountant");
    await postMarketPurchase(as.owner, purchase({ lines: [line(short[0].short.toFixed(), "655")] }));
    expect(shortages(await getDeliveryRows(as.warehouse_manager, (await getSalesDocument(as.warehouse_manager, note.id))!))).toEqual([]);
    const posted = await postDelivery(as.warehouse_manager, note.id);
    expect(posted.number).toBe("DN-2627-00001");
    expect(await stock()).toBe("0 worth 0");
    expect([await balance("ap"), await balance("grni")]).toEqual(["0.00", "0.00"]);
  });
});
