import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getGrni, getOrder } from "@/modules/purchasing/queries";
import { discardBill, postBill, saveBillDraft } from "@/modules/supplier-bills/commands";
import type { RawBill } from "@/modules/supplier-bills/rules";
import { postPayment, savePaymentDraft } from "@/modules/supplier-payments/commands";
import { listBillsOwed } from "@/modules/supplier-payments/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { applyReturnCredit, discardReturn, postReturn, saveReturnDraft } from "./commands";
import { getReturn, getReturnStart, listReceiptsToReturn, listReturns } from "./queries";
import type { RawReturn } from "./rules";

// Goods sent back to suppliers against a real database, through the app's own path
// (app_runtime, withTenant, row-level security): what a return posts, what is refused, and
// that the books always agree with the stock, with what is waiting for a bill and with what is
// owed to suppliers. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-return-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@return.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const ORDERED = "2026-11-02";
const ARRIVED = "2026-11-03";
const BILLED = "2026-11-04";
const RETURNED = "2026-11-06";

let admin: AdminSql;
/** An AOP that is not registered for sales tax: its bills carry no tax. */
let plain = "";
let trader = "";
/** A company registered for sales tax, with an STRN: input tax is claimed on its bills. */
let registered = "";
let standard = "";
let bank = "";
let helmet = "";
let glove = "";
let visor = "";
let grip = "";
let chain = "";
let invoiceNo = 0;

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
const rowsOf = async (who: TenantContext, statement: ReturnType<typeof sql>) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement))).length;
const journalOf = async (journalId: string | null) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line
      from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.journal_id = ${journalId} order by l.line_no`
  ).map((row) => row.line);
/** The balance of a locked account as a liability (credit less debit). */
const balance = async (control: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = ${control}`
  )[0].v;
/** What the books say is owed to one supplier (above nothing), or that it owes back (below). */
const owedTo = async (supplierId: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = 'ap' and l.supplier_id = ${supplierId}`
  )[0].v;
/** What the warehouse holds of an item: quantity and value. */
const stock = async (itemId: string) => {
  const [row] = await admin<{ q: string; v: string }[]>`select trim_scale(quantity)::text as q, trim_scale(value)::text as v from public.stock_balances where tenant_id = ${tenantA} and item_id = ${itemId} and warehouse_id = ${mainWarehouse}`;
  return row ? `${row.q} worth ${row.v}` : "none";
};
/** That the stock account in the books is what the stock is worth. */
const stockAgrees = async () => {
  const [{ held }] = await admin<{ held: string }[]>`select coalesce(sum(value), 0)::numeric(20,2)::text as held from public.stock_balances where tenant_id = ${tenantA}`;
  return (0 - Number(await balance("inventory"))).toFixed(2) === held;
};

/** Goods ordered from a supplier and received in full: the goods received note and its one line. */
async function received(supplierId: string, itemId: string, quantity: string, unitCost: string): Promise<{ receiptId: string; lineId: string; number: string }> {
  const order = await saveOrderDraft(as.owner, null, { date: ORDERED, supplierId, warehouseId: mainWarehouse, lines: [{ itemId, quantity, unitCost }] });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveReceiptDraft(as.warehouse_manager, null, order.id, { date: ARRIVED, lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  const { number } = await postReceipt(as.warehouse_manager, note.id);
  const [{ id: lineId }] = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id}`;
  return { receiptId: note.id, lineId, number };
}
const bill = (supplierId: string, over: Partial<RawBill>): RawBill => ({ date: BILLED, supplierId, branchId: mainBranch, supplierInvoiceNo: `INV-${(invoiceNo += 1)}`, ...over });
/** A bill for goods of one received line, saved and posted: the bill and its one line. */
async function billed(supplierId: string, receiptLineId: string, quantity: string, unitPrice: string, taxCategoryId?: string): Promise<{ id: string; number: string; lineId: string }> {
  const { id, updatedAt } = await saveBillDraft(as.accountant, null, bill(supplierId, { goods: [{ receiptLineId, quantity, unitPrice, taxCategoryId }] }));
  const { number } = await postBill(as.accountant, id, updatedAt);
  const [{ id: lineId }] = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where tenant_id = ${tenantA} and bill_id = ${id}`;
  return { id, number, lineId };
}
const goingBack = (receiptId: string, lines: RawReturn["lines"], over: Partial<RawReturn> = {}): RawReturn => ({ date: RETURNED, receiptId, reason: "Damaged in transit", lines, ...over });
/** A return saved and posted by the accountant. */
async function sentBack(raw: RawReturn, who: TenantContext = as.accountant): Promise<{ id: string; number: string }> {
  const { id, updatedAt } = await saveReturnDraft(who, null, raw);
  return { id, ...(await postReturn(who, id, updatedAt)) };
}
/** What can still go back from a goods received note, in words. */
const canGoBack = async (receiptId: string) => (await getReturnStart(as.accountant, receiptId))!.canGoBack.map((row) => `${row.itemCode} ${row.billNumber ?? "not billed"}: ${row.available.toFixed()} at ${row.unitValue.toFixed()}`);
const owed = async (supplierId: string) => (await listBillsOwed(as.accountant, supplierId, mainBranch)).map((row) => `${row.number}: ${row.owed.toFixed(2)} of ${row.payable.toFixed(2)}`);

describe.skipIf(!hasDb)("supplier returns", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      // An accountant who works in the north branch only: the main branch's returns are not theirs.
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    // Registered for sales tax, with the tax tables as a new company gets them (rates from 1 July 2026).
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    const item = async (code: string, name: string) => (await createItem(as.owner, { code, name, unit: piece, defaultPrice: "1000" })).id;
    helmet = await item("HL-1", "Helmet");
    glove = await item("GL-2", "Gloves");
    visor = await item("VS-3", "Visor");
    grip = await item("GR-4", "Grip");
    chain = await item("CH-5", "Chain");
    plain = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    trader = (await createParty(as.owner, "supplier", { name: "Multan Traders", supplierType: "aop" })).id;
    registered = (await createParty(as.owner, "supplier", { name: "Sialkot Sports Ltd", supplierType: "company", registrationType: "registered", ntn: "7654321", strn: "3277876123456", atlStatus: "active" })).id;
    [{ id: standard }] = await admin<{ id: string }[]>`select id from public.tax_categories where tenant_id = ${tenantA} and kind = 'standard' order by created_at limit 1`;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("the plan's test, goods not yet billed: sending them back reverses Goods received not invoiced, and they can no longer be billed", async () => {
    // Ten helmets at 600 arrive: 6,000 in stock, 6,000 waiting for a bill.
    const helmets = await received(plain, helmet, "10", "600");
    expect(await balance("grni")).toBe("6000.00");
    expect(await canGoBack(helmets.receiptId)).toEqual(["HL-1 not billed: 10 at 600"]);
    expect((await listReceiptsToReturn(as.accountant)).map((row) => `${row.number} ${row.supplierName}`)).toEqual([`${helmets.number} Lahore Parts`]);
    const four = goingBack(helmets.receiptId, [{ receiptLineId: helmets.lineId, quantity: "4" }], { reason: "Cracked shells" });
    // Who, what and when.
    await expect(saveReturnDraft(as.warehouse_manager, null, four)).rejects.toThrow("Only an owner or an accountant can send goods back to a supplier.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, reason: " " })).rejects.toThrow("Say why the goods are going back, in a few words.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, lines: [{ receiptLineId: helmets.lineId, quantity: "0" }] })).rejects.toThrow("Enter how much goes back of at least one line.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, lines: [{ receiptLineId: helmets.lineId, quantity: "11" }] })).rejects.toThrow("HL-1 not yet billed: only 10 can go back, not 11.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, date: ORDERED })).rejects.toThrow("The goods arrived on 03-11-2026. They cannot go back before that day.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, date: "2099-01-01" })).rejects.toThrow("A return cannot be dated on a day that has not come yet.");
    await expect(saveReturnDraft(as.accountant, null, { ...four, receiptId: randomUUID() })).rejects.toThrow("Choose a posted goods received note from the list.");

    const draft = await saveReturnDraft(as.accountant, null, four);
    // A draft moves nothing.
    expect(await stock(helmet)).toBe("10 worth 6000");
    expect(await balance("grni")).toBe("6000.00");
    await expect(postReturn(as.accountant, draft.id, new Date(draft.updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this return after you opened it.");
    expect(await postReturn(as.accountant, draft.id, draft.updatedAt)).toEqual({ number: "DB-2627-00001" });
    const done = await getReturn(as.auditor, draft.id);
    expect(done).toMatchObject({ status: "posted", number: "DB-2627-00001", reason: "Cracked shells" });
    expect([done!.grniValue.toFixed(2), done!.credit.toFixed(2), done!.stockValue.toFixed(2), done!.creditLeft.toFixed(2)]).toEqual(["2400.00", "0.00", "2400.00", "0.00"]);
    expect(done!.lines.map((line) => `${line.itemCode} ${line.quantity.toFixed()} ${line.billNumber ?? "not billed"} ${line.grniValue?.toFixed(2)}`)).toEqual(["HL-1 4 not billed 2400.00"]);
    // The plan's words: it reverses Goods received not invoiced.
    expect(await journalOf(done!.journalId)).toEqual(["2120 Goods received not invoiced: 2400 / 0", "1300 Stock in trade: 0 / 2400"]);
    expect(await stock(helmet)).toBe("6 worth 3600");
    expect(await balance("grni")).toBe("3600.00");
    expect(await owedTo(plain)).toBe("0.00");
    // The report of goods waiting for a bill shows the six that stayed, and agrees with the books.
    const grni = await getGrni(as.auditor);
    expect(grni.rows.map((row) => `${row.itemCode} ${row.quantity.toFixed()} ${row.value.toFixed(2)}`)).toEqual(["HL-1 6 3600.00"]);
    expect([grni.total.toFixed(2), grni.ledger.toFixed(2)]).toEqual(["3600.00", "3600.00"]);

    // What went back cannot be billed: six are left to bill, and billing them clears the account exactly.
    await expect(saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: helmets.lineId, quantity: "7", unitPrice: "600" }] }))).rejects.toThrow(`HL-1: 10 arrived on ${helmets.number} and 4 has been sent back, so only 6 more can be billed.`);
    // Written past the app: a bill for seven is refused by the database when it is posted.
    const forged = await saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: helmets.lineId, quantity: "6", unitPrice: "600" }] }));
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`delete from public.supplier_bill_lines where bill_id = ${forged.id}`));
    expect(await codeOf(as.accountant, sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, receipt_line_id, item_id, description, quantity, unit_price, amount, created_by) values (${tenantA}, ${forged.id}, 1, 'goods', ${helmets.lineId}, ${helmet}, 'Helmet', 7, 600, 4200, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`update public.supplier_bills set amount = 4200, total = 4200 where id = ${forged.id}`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_bill(${forged.id}::uuid)`)).toBe("SE228");
    await discardBill(as.accountant, forged.id);
    const six = await billed(plain, helmets.lineId, "6", "600");
    expect(await balance("grni")).toBe("0.00");
    expect(await owedTo(plain)).toBe("3600.00");
    // Nothing unbilled is left to send back; the six billed ones still can go.
    expect(await canGoBack(helmets.receiptId)).toEqual([`HL-1 ${six.number}: 6 at 600`]);
    // Written past the app: unbilled goods that are no longer there are refused when the return is posted.
    const late = await saveReturnDraft(as.accountant, null, goingBack(helmets.receiptId, [{ receiptLineId: helmets.lineId, billLineId: six.lineId, quantity: "1" }]));
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`delete from public.supplier_return_lines where return_id = ${late.id}`));
    expect(await codeOf(as.accountant, sql`insert into public.supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, item_id, unit_factor, quantity, base_quantity, created_by) values (${tenantA}, ${late.id}, 1, ${helmets.lineId}, ${helmet}, 1, 1, 1, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_return(${late.id}::uuid)`)).toBe("SE251");
    await discardReturn(as.accountant, late.id);

    // A posted return is not changed, thrown away or posted twice.
    await expect(saveReturnDraft(as.owner, draft.id, four)).rejects.toThrow("This return is posted and cannot be changed.");
    await expect(discardReturn(as.owner, draft.id)).rejects.toThrow("This return is posted and cannot be removed.");
    await expect(postReturn(as.owner, draft.id)).rejects.toThrow("This return is already posted.");
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'supplier_return' and entity_id = ${draft.id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["supplier_return.create", "supplier_return.post"]);
    expect(await stockAgrees()).toBe(true);
  });

  it("the plan's test, goods already billed: sending them back is a debit note that brings down what is owed to the supplier, with the input tax claimed on them", async () => {
    // Ten pairs of gloves at 200 arrive and are billed at 220 with 18% sales tax: 2,200 + 396 = 2,596 owed.
    const gloves = await received(registered, glove, "10", "200");
    const invoice = await billed(registered, gloves.lineId, "10", "220", standard);
    expect(await owed(registered)).toEqual([`${invoice.number}: 2596.00 of 2596.00`]);
    expect(await canGoBack(gloves.receiptId)).toEqual([`GL-2 ${invoice.number}: 10 at 220`]);
    const three = goingBack(gloves.receiptId, [{ receiptLineId: gloves.lineId, billLineId: invoice.lineId, quantity: "3" }], { supplierReference: "CN-118" });
    // Billed goods do not go back before their bill.
    await expect(saveReturnDraft(as.accountant, null, { ...three, date: ARRIVED })).rejects.toThrow(`GL-2 billed on ${invoice.number}: the bill is dated 04-11-2026. Billed goods go back on or after the day of their bill.`);
    const first = await sentBack(three);
    const done = await getReturn(as.accountant, first.id);
    expect(done).toMatchObject({ number: "DB-2627-00002", supplierReference: "CN-118" });
    // Three tenths of the bill line: 660 of goods and 118.80 of tax. The goods were carried at 200 each.
    expect([done!.billedAmount.toFixed(2), done!.salesTax.toFixed(2), done!.credit.toFixed(2), done!.stockValue.toFixed(2), done!.grniValue.toFixed(2)]).toEqual(["660.00", "118.80", "778.80", "600.00", "0.00"]);
    // The plan's words: it reverses what is owed to the supplier (AP).
    expect(await journalOf(done!.journalId)).toEqual([
      "2110 Trade payables: 778.8 / 0",
      "5120 Purchase price differences: 0 / 60",
      "1400 Sales tax receivable (input tax): 0 / 118.8",
      "1300 Stock in trade: 0 / 600",
    ]);
    // It came off the bill it was billed on, which is owed that much less.
    expect(done!.allocations.map((line) => `${line.billNumber} ${line.amount.toFixed(2)} on ${line.appliedOn}`)).toEqual([`${invoice.number} 778.80 on ${RETURNED}`]);
    expect(done!.creditLeft.toFixed(2)).toBe("0.00");
    expect(await owed(registered)).toEqual([`${invoice.number}: 1817.20 of 2596.00`]);
    expect(await owedTo(registered)).toBe("1817.20");
    expect(await stock(glove)).toBe("7 worth 1400");
    expect(await canGoBack(gloves.receiptId)).toEqual([`GL-2 ${invoice.number}: 7 at 220`]);

    // The other seven go back too: the bill is given back to the paisa, and nothing of it is left anywhere.
    await expect(saveReturnDraft(as.accountant, null, goingBack(gloves.receiptId, [{ receiptLineId: gloves.lineId, billLineId: invoice.lineId, quantity: "8" }]))).rejects.toThrow(`GL-2 billed on ${invoice.number}: only 7 can go back, not 8.`);
    const rest = await sentBack(goingBack(gloves.receiptId, [{ receiptLineId: gloves.lineId, billLineId: invoice.lineId, quantity: "7" }]));
    expect(await journalOf((await getReturn(as.accountant, rest.id))!.journalId)).toEqual([
      "2110 Trade payables: 1817.2 / 0",
      "5120 Purchase price differences: 0 / 140",
      "1400 Sales tax receivable (input tax): 0 / 277.2",
      "1300 Stock in trade: 0 / 1400",
    ]);
    expect(await owed(registered)).toEqual([]);
    expect(await owedTo(registered)).toBe("0.00");
    expect(await stock(glove)).toBe("0 worth 0");
    expect(await balance("input_tax")).toBe("0.00");
    // The bill's price difference (200 dearer than the order) has come back in full.
    expect(await balance("purchase_price_difference")).toBe("0.00");
    expect(await canGoBack(gloves.receiptId)).toEqual([]);
    // Written past the app: one more than the bill billed is refused when the return is posted.
    const forged = randomUUID();
    const me = userIds.accountant;
    expect(await codeOf(as.accountant, sql`insert into public.supplier_returns (id, tenant_id, return_date, receipt_id, supplier_id, warehouse_id, branch_id, reason, created_by, updated_by) values (${forged}, ${tenantA}, ${RETURNED}, ${gloves.receiptId}, ${registered}, ${mainWarehouse}, ${mainBranch}, 'One more', ${me}, ${me})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`insert into public.supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, bill_line_id, item_id, unit_factor, quantity, base_quantity, created_by) values (${tenantA}, ${forged}, 1, ${gloves.lineId}, ${invoice.lineId}, ${glove}, 1, 1, 1, ${me})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_return(${forged}::uuid)`)).toBe("SE251");
    await discardReturn(as.accountant, forged);
    expect(await stockAgrees()).toBe(true);
  });

  it("goods of a bill that is already paid: the supplier owes the money back, and it is set against another bill later", async () => {
    // Five visors at 100, billed and paid in full.
    const visors = await received(trader, visor, "5", "100");
    const paidBill = await billed(trader, visors.lineId, "5", "100");
    const payment = await savePaymentDraft(as.accountant, null, { date: BILLED, supplierId: trader, branchId: mainBranch, accountId: bank, amount: "500", allocations: [{ billId: paidBill.id, amount: "500" }] });
    await postPayment(as.accountant, payment.id, payment.updatedAt);
    expect(await owed(trader)).toEqual([]);
    // Two go back. Nothing is owed on their bill, so the 200 stays a credit with the supplier.
    const back = await sentBack(goingBack(visors.receiptId, [{ receiptLineId: visors.lineId, billLineId: paidBill.lineId, quantity: "2" }]));
    const done = await getReturn(as.accountant, back.id);
    expect(await journalOf(done!.journalId)).toEqual(["2110 Trade payables: 200 / 0", "1300 Stock in trade: 0 / 200"]);
    expect([done!.credit.toFixed(2), done!.creditUsed.toFixed(2), done!.creditLeft.toFixed(2)]).toEqual(["200.00", "0.00", "200.00"]);
    expect(done!.allocations).toEqual([]);
    // The books show the supplier owing 200 back.
    expect(await owedTo(trader)).toBe("-200.00");
    expect((await listReturns(as.auditor)).rows.find((row) => row.id === back.id)).toMatchObject({ number: back.number, supplierName: "Multan Traders", receiptNumber: visors.number });
    expect((await listReturns(as.auditor)).rows.find((row) => row.id === back.id)!.creditLeft.toFixed(2)).toBe("200.00");

    // More visors arrive and are billed: 400 owed. The credit is set against it.
    const more = await received(trader, visor, "4", "100");
    const next = await billed(trader, more.lineId, "4", "100");
    expect(await owed(trader)).toEqual([`${next.number}: 400.00 of 400.00`]);
    const journals = async () => (await admin<{ n: number }[]>`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n;
    const before = await journals();
    await expect(applyReturnCredit(as.auditor, back.id, { date: RETURNED, allocations: [{ billId: next.id, amount: "200" }] })).rejects.toThrow("Only an owner or an accountant can send goods back to a supplier.");
    await expect(applyReturnCredit(as.accountant, back.id, { date: "2026-11-05", allocations: [{ billId: next.id, amount: "200" }] })).rejects.toThrow("The return is dated 06-11-2026. Its credit cannot be set against a bill before that.");
    await expect(applyReturnCredit(as.accountant, back.id, { date: RETURNED, allocations: [{ billId: next.id, amount: "200.01" }] })).rejects.toThrow("200.01 is set against bills, more than what is left of the credit: 200.00.");
    await expect(applyReturnCredit(as.accountant, back.id, { date: RETURNED, allocations: [] })).rejects.toThrow("Enter an amount against at least one bill.");
    expect(await applyReturnCredit(as.accountant, back.id, { date: "2026-11-07", allocations: [{ billId: next.id, amount: "150" }] })).toEqual({ bills: 1 });
    expect(await owed(trader)).toEqual([`${next.number}: 250.00 of 400.00`]);
    const applied = await getReturn(as.accountant, back.id);
    expect(applied!.allocations.map((line) => `${line.billNumber} ${line.amount.toFixed(2)} on ${line.appliedOn}`)).toEqual([`${next.number} 150.00 on 2026-11-07`]);
    expect(applied!.creditLeft.toFixed(2)).toBe("50.00");
    // Nothing was posted to the books for it: the debit note had already taken the whole 200 off what is owed.
    expect(await journals()).toBe(before);
    expect(await owedTo(trader)).toBe("200.00");
    // Written past the app: more than is left, more than is owed, a bill of another supplier, the same bill twice, a draft.
    const call = (list: unknown) => sql`select app.apply_supplier_return_credit(${back.id}::uuid, '2026-11-07'::date, ${JSON.stringify(list)}::jsonb)`;
    expect(await codeOf(as.accountant, call([{ bill_id: next.id, amount: "50.01" }])), "more than is left").toBe("SE253");
    expect(await codeOf(as.accountant, call([{ bill_id: next.id, amount: "25" }, { bill_id: next.id, amount: "25" }])), "twice").toBe("SE253");
    expect(await codeOf(as.accountant, call([{ bill_id: next.id, amount: "-5" }])), "less than nothing").toBe("SE253");
    expect(await codeOf(as.accountant, call([{ bill_id: next.id, amount: "NaN" }])), "not a number").toBe("SE253");
    expect(await codeOf(as.accountant, call([])), "no bills").toBe("SE253");
    const [{ id: theirBill }] = await admin<{ id: string }[]>`select id from public.supplier_bills where tenant_id = ${tenantA} and supplier_id = ${plain} and status = 'posted' limit 1`;
    expect(await codeOf(as.accountant, call([{ bill_id: theirBill, amount: "10" }])), "another supplier's bill").toBe("SE253");
    // The rest of the credit takes the bill down further; then a payment cannot settle more than is left owed.
    await applyReturnCredit(as.owner, back.id, { date: "2026-11-07", allocations: [{ billId: next.id, amount: "50" }] });
    expect(await owed(trader)).toEqual([`${next.number}: 200.00 of 400.00`]);
    await expect(savePaymentDraft(as.accountant, null, { date: "2026-11-08", supplierId: trader, branchId: mainBranch, accountId: bank, amount: "300", allocations: [{ billId: next.id, amount: "200.01" }] })).rejects.toThrow(`${next.number}: 200.00 is still owed on it, so 200.01 cannot be set against it.`);
    const settle = await savePaymentDraft(as.accountant, null, { date: "2026-11-08", supplierId: trader, branchId: mainBranch, accountId: bank, amount: "200", allocations: [{ billId: next.id, amount: "200" }] });
    await postPayment(as.accountant, settle.id, settle.updatedAt);
    expect(await owed(trader)).toEqual([]);
    expect(await owedTo(trader)).toBe("0.00");
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'supplier_return' and entity_id = ${back.id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["supplier_return.create", "supplier_return.post", "supplier_return.apply_credit", "supplier_return.apply_credit"]);
  });

  it("one return for goods partly billed: each part undoes its own side, at what the stock is carried at, and what is left is exact", async () => {
    // Ten grips at 40 arrive (400); six are billed at 45 (270: 240 off the account, 30 of price difference).
    const first = await received(plain, grip, "10", "40");
    const invoice = await billed(plain, first.lineId, "6", "45");
    // Ten more arrive at 50: twenty are held at 900, 45 each on average.
    await received(plain, grip, "10", "50");
    expect(await stock(grip)).toBe("20 worth 900");
    expect(await canGoBack(first.receiptId)).toEqual(["GR-4 not billed: 4 at 40", `GR-4 ${invoice.number}: 6 at 45`]);
    const grniBefore = Number(await balance("grni"));
    const owedBefore = Number(await owedTo(plain));
    // Three of the unbilled and two of the billed go back together.
    const back = await sentBack(goingBack(first.receiptId, [{ receiptLineId: first.lineId, quantity: "3" }, { receiptLineId: first.lineId, billLineId: invoice.lineId, quantity: "2" }]));
    const done = await getReturn(as.accountant, back.id);
    expect(done!.lines.map((line) => `${line.billNumber ?? "not billed"} ${line.quantity.toFixed()}: stock ${line.stockValue?.toFixed(2)}, account ${line.grniValue?.toFixed(2) ?? "-"}, bill ${line.amount?.toFixed(2) ?? "-"}`)).toEqual([
      "not billed 3: stock 135.00, account 120.00, bill -",
      `${invoice.number} 2: stock 90.00, account -, bill 90.00`,
    ]);
    // 120 off goods received not invoiced, 90 off the supplier; 225 left stock; the 15 between is a price difference.
    expect(await journalOf(done!.journalId)).toEqual([
      "2120 Goods received not invoiced: 120 / 0",
      "2110 Trade payables: 90 / 0",
      "5120 Purchase price differences: 15 / 0",
      "1300 Stock in trade: 0 / 225",
    ]);
    expect(await stock(grip)).toBe("15 worth 675");
    expect(grniBefore - Number(await balance("grni"))).toBe(120);
    expect(owedBefore - Number(await owedTo(plain))).toBe(90);
    expect(await canGoBack(first.receiptId)).toEqual(["GR-4 not billed: 1 at 40", `GR-4 ${invoice.number}: 4 at 45`]);
    // The one grip still unbilled is billed: it clears exactly the 40 that was left on the account for this note.
    const last = await billed(plain, first.lineId, "1", "40");
    const [{ received_value: cleared }] = await admin<{ received_value: string }[]>`select received_value::text from public.supplier_bill_lines where id = ${last.lineId}`;
    expect(cleared).toBe("40.00");
    const grni = await getGrni(as.auditor);
    expect(grni.total.toFixed(2)).toBe(grni.ledger.toFixed(2));

    // Goods that were sold or lost cannot be sent back: fourteen grips are written off, one is left.
    const lost = await saveAdjustmentDraft(as.owner, "adjustment", null, { date: RETURNED, warehouseId: mainWarehouse, reason: "lost", lines: [{ itemCode: "GR-4", direction: "out", quantity: "14" }] });
    await postAdjustment(as.owner, lost.id);
    expect(await stock(grip)).toMatch(/^1 worth /);
    const two = goingBack(first.receiptId, [{ receiptLineId: first.lineId, billLineId: invoice.lineId, quantity: "2" }]);
    await expect(saveReturnDraft(as.accountant, null, two)).rejects.toThrow("GR-4: the warehouse holds 1, so 2 cannot go back.");
    // Written past the app: the database refuses to take out of the warehouse what it does not hold.
    const one = await saveReturnDraft(as.accountant, null, goingBack(first.receiptId, [{ receiptLineId: first.lineId, billLineId: invoice.lineId, quantity: "1" }]));
    await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`delete from public.supplier_return_lines where return_id = ${one.id}`));
    expect(await codeOf(as.accountant, sql`insert into public.supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, bill_line_id, item_id, unit_factor, quantity, base_quantity, created_by) values (${tenantA}, ${one.id}, 1, ${first.lineId}, ${invoice.lineId}, ${grip}, 1, 2, 2, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_return(${one.id}::uuid)`)).toBe("SE060");
    await discardReturn(as.accountant, one.id);
    expect(await stockAgrees()).toBe(true);
  });

  it("keeps a return to those who may write it, and its figures to the database", async () => {
    const chains = await received(plain, chain, "8", "300");
    const invoice = await billed(plain, chains.lineId, "4", "300");
    const other = await received(trader, chain, "2", "300");
    const draft = await saveReturnDraft(as.accountant, null, goingBack(chains.receiptId, [{ receiptLineId: chains.lineId, quantity: "1" }]));
    const me = userIds.accountant;
    // The app's role cannot say a return is posted, give it a number or a journal, or name a figure.
    expect(await codeOf(as.accountant, sql`update public.supplier_returns set status = 'posted' where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.supplier_returns set number = 'DB-2627-00099' where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.supplier_returns set credit = 5 where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.supplier_returns set receipt_id = ${other.receiptId} where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`insert into public.supplier_returns (tenant_id, status, number, return_date, receipt_id, supplier_id, warehouse_id, branch_id, reason, created_by, updated_by) values (${tenantA}, 'posted', 'DB-2627-00099', ${RETURNED}, ${chains.receiptId}, ${plain}, ${mainWarehouse}, ${mainBranch}, 'forged', ${me}, ${me})`)).toBeDefined();
    // A return is for a posted goods received note, its own supplier, its own warehouse and that warehouse's branch.
    const forgedHead = (receiptId: string, supplierId: string, branchId: string) => sql`insert into public.supplier_returns (tenant_id, return_date, receipt_id, supplier_id, warehouse_id, branch_id, reason, created_by, updated_by) values (${tenantA}, ${RETURNED}, ${receiptId}, ${supplierId}, ${mainWarehouse}, ${branchId}, 'forged', ${me}, ${me})`;
    expect(await codeOf(as.accountant, forgedHead(chains.receiptId, trader, mainBranch)), "another supplier").toBe("SE254");
    expect(await codeOf(as.accountant, forgedHead(chains.receiptId, plain, northBranch)), "another branch").toBe("SE254");
    expect(await codeOf(as.accountant, forgedHead(randomUUID(), plain, mainBranch)), "no such note").toBe("SE254");
    // A line is a line of the return's own note, for no more than arrived; a bill line is that line's own.
    const line = (receiptLineId: string, quantity: number, billLineId: string | null = null) => sql`insert into public.supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, bill_line_id, item_id, unit_factor, quantity, base_quantity, created_by) values (${tenantA}, ${draft.id}, 9, ${receiptLineId}, ${billLineId}, ${chain}, 1, ${quantity}, ${quantity}, ${me})`;
    expect(await codeOf(as.accountant, line(other.lineId, 1)), "another note's goods").toBe("SE249");
    expect(await codeOf(as.accountant, line(chains.lineId, 9, invoice.lineId)), "more than arrived").toBe("SE249");
    expect(await codeOf(as.accountant, line(chains.lineId, 5, invoice.lineId)), "more than the bill billed").toBe("SE249");
    expect(await codeOf(as.accountant, sql`insert into public.supplier_return_lines (tenant_id, return_id, line_no, receipt_line_id, item_id, unit_factor, quantity, base_quantity, grni_value, created_by) values (${tenantA}, ${draft.id}, 9, ${chains.lineId}, ${chain}, 1, 1, 1, 5000, ${me})`), "a figure").toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.supplier_return_lines set quantity = 2, base_quantity = 2 where return_id = ${draft.id}`)).toBe("42501");
    // What a credit was set against is the database's alone.
    expect(await codeOf(as.accountant, sql`insert into public.supplier_return_allocations (tenant_id, return_id, bill_id, amount, applied_on, created_by) values (${tenantA}, ${draft.id}, ${invoice.id}, 100, ${RETURNED}, ${me})`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`update public.supplier_return_allocations set amount = 1`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`delete from public.supplier_return_allocations`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id) values (${tenantA}, ${me}, 'accountant', 'supplier_return.post', 'x', ${draft.id})`)).toBeDefined();
    expect(await codeOf(as.accountant, sql`select app.hold_supplier_return(${draft.id}::uuid)`)).toBe("42501");
    expect(await codeOf(as.accountant, sql`select app.bill_owed(${tenantA}::uuid, ${invoice.id}::uuid)`)).toBe("42501");

    // Returns are for the owner and whoever keeps or checks the books; the auditor only reads.
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(listReturns(as[role]), role).rejects.toThrow("Your role does not include supplier returns.");
      expect(await rowsOf(as[role], sql`select 1 from public.supplier_returns`), role).toBe(0);
      expect(await rowsOf(as[role], sql`select 1 from public.supplier_return_lines`), role).toBe(0);
      expect(await codeOf(as[role], sql`select app.post_supplier_return(${draft.id}::uuid)`), role).toBe("42501");
    }
    expect((await getReturn(as.auditor, draft.id))!.status).toBe("draft");
    expect(await codeOf(as.auditor, sql`select app.post_supplier_return(${draft.id}::uuid)`)).toBe("42501");
    // An accountant of the north branch does not see, change or post the main branch's returns.
    expect(await getReturn(north, draft.id)).toBeNull();
    expect((await listReturns(north)).rows).toEqual([]);
    expect(await getReturnStart(north, chains.receiptId)).toBeNull();
    await expect(postReturn(north, draft.id)).rejects.toThrow("That supplier return is not in this company.");
    expect(await codeOf(north, sql`select app.post_supplier_return(${draft.id}::uuid)`)).toBe("SE246");
    // Another company sees nothing of it.
    expect(await rowsOf(otherOwner, sql`select 1 from public.supplier_returns`)).toBe(0);
    expect(await codeOf(otherOwner, sql`select app.post_supplier_return(${draft.id}::uuid)`)).toBe("SE246");

    // Posted, it stays as it is: not even its own journal is removed or reversed by the app's role.
    const { number } = await postReturn(as.accountant, draft.id);
    const [done] = await admin<{ journal_id: string }[]>`select journal_id from public.supplier_returns where id = ${draft.id}`;
    expect(number).toMatch(/^DB-2627-\d{5}$/);
    expect(await codeOf(as.owner, sql`update public.supplier_returns set reason = 'changed', updated_by = ${userIds.owner} where id = ${draft.id}`)).toBeUndefined();
    expect((await getReturn(as.owner, draft.id))!.reason).toBe("Damaged in transit");
    expect(await codeOf(as.owner, sql`delete from public.supplier_returns where id = ${draft.id}`)).toBeUndefined();
    expect(await getReturn(as.owner, draft.id)).not.toBeNull();
    expect(await codeOf(as.owner, sql`delete from public.supplier_return_lines where return_id = ${draft.id}`)).toBeUndefined();
    expect((await getReturn(as.owner, draft.id))!.lines).toHaveLength(1);
    expect(await codeOf(as.owner, sql`delete from public.journals where id = ${done.journal_id}`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.reverse_journal(${done.journal_id}::uuid, ${RETURNED}::date, 'undo')`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.post_supplier_return(${draft.id}::uuid)`)).toBe("SE247");
  });

  it("sends the same goods back once when two returns are posted at the same moment", async () => {
    for (let round = 0; round < 4; round += 1) {
      const chains = await received(plain, chain, "5", "300");
      const drafts = await Promise.all([0, 1].map(() => saveReturnDraft(as.accountant, null, goingBack(chains.receiptId, [{ receiptLineId: chains.lineId, quantity: "5" }]))));
      const results = await Promise.allSettled(drafts.map((draft, index) => postReturn(index === 0 ? as.accountant : as.owner, draft.id)));
      expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
      for (const [index, result] of results.entries()) if (result.status === "rejected") await discardReturn(as.owner, drafts[index].id);
    }
    // A bill and a return for the same unbilled goods, at the same moment: one of them goes through.
    for (let round = 0; round < 4; round += 1) {
      const chains = await received(plain, chain, "5", "300");
      const goods = await saveReturnDraft(as.accountant, null, goingBack(chains.receiptId, [{ receiptLineId: chains.lineId, quantity: "5" }]));
      const invoice = await saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: chains.lineId, quantity: "5", unitPrice: "300" }] }));
      const results = await Promise.allSettled([postReturn(as.accountant, goods.id), postBill(as.owner, invoice.id)]);
      expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
    }
    const grni = await getGrni(as.auditor);
    expect(grni.total.toFixed(2)).toBe(grni.ledger.toFixed(2));
    expect(await stockAgrees()).toBe(true);
  });
});
