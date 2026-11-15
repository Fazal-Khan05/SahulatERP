import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getGrni, getOrder } from "@/modules/purchasing/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { discardBill, postBill, saveBillDraft, setWithholding } from "./commands";
import { getBill, getBillChoices, getPurchaseSettings, listBills, listReceiptLinesToBill } from "./queries";
import type { RawBill } from "./rules";

// Supplier bills against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): what each posts, what is withheld and at which rate of the dated tables,
// what is refused, and that the books always agree with what was received, billed and withheld.
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-bill-test";
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
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@bill.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const ORDERED = "2026-11-10";
const ARRIVED = "2026-11-11";
const BILLED = "2026-11-12";

let admin: AdminSql;
/** An AOP, not registered for sales tax, not on the Active Taxpayers List. */
let plain = "";
/** A company, not registered for sales tax, not on the list. */
let company = "";
/** A company registered for sales tax with an STRN, on the list. */
let registered = "";
let helmet = "";
let grip = "";
let standard = "";
let freight = "";
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
const journalLines = async (billId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.source_type = 'supplier_bill' and j.source_id = ${billId} order by l.line_no`
  ).map((row) => row.line);
const balance = async (control: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = ${control}`
  )[0].v;

/** Goods ordered from a supplier and received in full into a warehouse: the lines of the goods received note. */
async function received(supplierId: string, lines: { itemId: string; quantity: string; unitCost: string }[], warehouseId = mainWarehouse): Promise<string[]> {
  const { id } = await saveOrderDraft(as.owner, null, { date: ORDERED, supplierId, warehouseId, lines });
  await submitOrder(as.owner, id);
  const order = await getOrder(as.owner, id);
  const note = await saveReceiptDraft(as.warehouse_manager, null, id, { date: ARRIVED, lines: order!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postReceipt(as.warehouse_manager, note.id);
  const rows = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id} order by line_no`;
  return rows.map((row) => row.id);
}
const bill = (supplierId: string, over: Partial<RawBill>): RawBill => ({ date: BILLED, supplierId, branchId: mainBranch, supplierInvoiceNo: `INV-${(invoiceNo += 1)}`, ...over });
/** A bill saved and posted by the accountant. */
async function posted(raw: RawBill, who: TenantContext = as.accountant): Promise<{ id: string; number: string }> {
  const { id, updatedAt } = await saveBillDraft(who, null, raw);
  return { id, ...(await postBill(who, id, updatedAt)) };
}

describe.skipIf(!hasDb)("supplier bills", { timeout: 600_000 }, () => {
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
    // Registered for sales tax, with the tax tables as a new company gets them (rates from 1 July 2026).
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1500" })).id;
    grip = (await createItem(as.owner, { code: "GR-3", name: "Grip", unit: piece, defaultPrice: "80" })).id;
    plain = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    company = (await createParty(as.owner, "supplier", { name: "Karachi Motors (Pvt) Ltd", supplierType: "company" })).id;
    registered = (await createParty(as.owner, "supplier", { name: "Sialkot Sports Ltd", supplierType: "company", registrationType: "registered", ntn: "7654321", strn: "3277876123456", atlStatus: "active" })).id;
    [{ id: standard }] = await admin<{ id: string }[]>`select id from public.tax_categories where tenant_id = ${tenantA} and kind = 'standard' order by created_at limit 1`;
    [{ id: freight }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '5260'`;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("bills goods at the order's price: what was received leaves goods received not invoiced and is owed to the supplier", async () => {
    const [helmets] = await received(plain, [{ itemId: helmet, quantity: "10", unitCost: "600" }]);
    expect((await getGrni(as.owner)).total.toFixed(2)).toBe("6000.00");
    // What can be billed: what arrived, at what the order said one costs.
    expect((await listReceiptLinesToBill(as.accountant, plain, mainBranch)).map((l) => `${l.receiptNumber} ${l.itemCode}: ${l.received} received, ${l.billed} billed, ordered at ${l.orderCost}`)).toEqual(["GR-2627-00001 HL-1: 10 received, 0 billed, ordered at 600"]);
    expect(await listReceiptLinesToBill(as.accountant, company, mainBranch)).toEqual([]);

    const draft = await saveBillDraft(as.accountant, null, bill(plain, { supplierInvoiceNo: "LP/771", dueDate: "2026-12-12", goods: [{ receiptLineId: helmets, quantity: "4", unitPrice: "600" }] }));
    const open = await getBill(as.accountant, draft.id);
    expect(open).toMatchObject({ status: "draft", number: null, supplierName: "Lahore Parts", branchName: "Main", supplierInvoiceNo: "LP/771", dueDate: "2026-12-12" });
    expect([open!.amount.toFixed(2), open!.salesTax.toFixed(2), open!.total.toFixed(2)]).toEqual(["2400.00", "0.00", "2400.00"]);
    expect(open!.preview).toMatchObject({ ok: true });
    // A draft posts nothing.
    expect(await balance("ap")).toBe("0.00");
    await expect(postBill(as.warehouse_manager, draft.id)).rejects.toThrow("Only an owner or an accountant can write supplier bills.");
    await expect(postBill(as.accountant, draft.id, new Date(draft.updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this bill after you opened it.");
    expect(await postBill(as.accountant, draft.id, draft.updatedAt)).toEqual({ number: "PB-2627-00001" });

    expect(await journalLines(draft.id)).toEqual(["2120 Goods received not invoiced: 2400 / 0", "2110 Trade payables: 0 / 2400"]);
    const done = await getBill(as.auditor, draft.id);
    expect(done).toMatchObject({ status: "posted", number: "PB-2627-00001" });
    expect([done!.withheld.toFixed(2), done!.payable.toFixed(2), done!.lines[0].receivedValue?.toFixed(2)]).toEqual(["0.00", "2400.00", "2400.00"]);
    // The payable names its supplier.
    const [{ supplier_id }] = await admin`select l.supplier_id from public.journal_lines l join public.accounts a on a.id = l.account_id where l.journal_id = ${done!.journalId} and a.control_type = 'ap'`;
    expect(supplier_id).toBe(plain);
    // Six helmets are still received and not billed, at what they came in at.
    const grni = await getGrni(as.owner);
    expect(grni.rows.map((row) => `${row.receiptNumber} ${row.itemCode} ${row.quantity}: ${row.value.toFixed(2)}`)).toEqual(["GR-2627-00001 HL-1 6: 3600.00"]);
    expect([grni.total.toFixed(2), grni.ledger.toFixed(2)]).toEqual(["3600.00", "3600.00"]);
    // A posted bill is not changed, thrown away or posted twice; its invoice number is not billed again.
    await expect(saveBillDraft(as.owner, draft.id, bill(plain, {}))).rejects.toThrow("This bill is posted and cannot be changed.");
    await expect(discardBill(as.owner, draft.id)).rejects.toThrow("This bill is posted and cannot be removed.");
    await expect(postBill(as.owner, draft.id)).rejects.toThrow("This bill is already posted.");
    const again = await saveBillDraft(as.accountant, null, bill(plain, { supplierInvoiceNo: " lp/771 ", goods: [{ receiptLineId: helmets, quantity: "1", unitPrice: "600" }] }));
    await expect(postBill(as.accountant, again.id)).rejects.toThrow("A bill with this supplier's invoice number has already been posted.");
    await discardBill(as.accountant, again.id);
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'supplier_bill' and entity_id = ${draft.id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["supplier_bill.create", "supplier_bill.post"]);
  });

  it("posts the difference to purchase price differences when the supplier bills another price, and never bills more than arrived", async () => {
    const [left] = await listReceiptLinesToBill(as.accountant, plain, mainBranch);
    await expect(saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: left.receiptLineId, quantity: "7", unitPrice: "600" }] }))).rejects.toThrow("HL-1: 10 arrived on GR-2627-00001 and 4 has been billed, so only 6 more can be billed.");
    // Dearer than the order: six helmets came in at 600 and are billed at 650.
    const dearer = await posted(bill(plain, { goods: [{ receiptLineId: left.receiptLineId, quantity: "6", unitPrice: "650" }] }));
    expect(await journalLines(dearer.id)).toEqual(["2120 Goods received not invoiced: 3600 / 0", "5120 Purchase price differences: 300 / 0", "2110 Trade payables: 0 / 3900"]);
    expect(await listReceiptLinesToBill(as.accountant, plain, mainBranch)).toEqual([]);
    // Cheaper: seven grips at 33.3333 came in at 233.33; three are billed at 30, then four at 33.
    const [grips] = await received(plain, [{ itemId: grip, quantity: "7", unitCost: "33.3333" }]);
    const three = await posted(bill(plain, { goods: [{ receiptLineId: grips, quantity: "3", unitPrice: "30" }] }));
    // 233.33 × 3/7 = 99.9986, so 100.00 leaves the account; the bill is for 90.00.
    expect(await journalLines(three.id)).toEqual(["2120 Goods received not invoiced: 100 / 0", "5120 Purchase price differences: 0 / 10", "2110 Trade payables: 0 / 90"]);
    const four = await posted(bill(plain, { goods: [{ receiptLineId: grips, quantity: "4", unitPrice: "33" }] }));
    // The rest of what the line came in at, to the paisa: 233.33 less the 100.00 already cleared.
    expect(await journalLines(four.id)).toEqual(["2120 Goods received not invoiced: 133.33 / 0", "5120 Purchase price differences: 0 / 1.33", "2110 Trade payables: 0 / 132"]);
    // Everything received has been billed: nothing is left in goods received not invoiced.
    const grni = await getGrni(as.owner);
    expect([grni.rows.length, grni.total.toFixed(2), grni.ledger.toFixed(2)]).toEqual([0, "0.00", "0.00"]);
    expect(await balance("ap")).toBe("6522.00");
    // Written past the app: a line for more than is left, though no more than arrived, waits as a draft and is refused when posted.
    const over = await saveBillDraft(as.accountant, null, bill(plain, {}));
    expect(await codeOf(as.accountant, sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, receipt_line_id, item_id, description, quantity, unit_price, amount, created_by)
      values (${tenantA}, ${over.id}, 1, 'goods', ${grips}, ${grip}, 'Grip', 1, 33, 33, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`update public.supplier_bills set amount = 33, total = 33, updated_by = ${userIds.accountant} where id = ${over.id}`)).toBeUndefined();
    await expect(postBill(as.accountant, over.id)).rejects.toThrow("More has been entered than was received and is not yet billed.");
    await discardBill(as.accountant, over.id);
  });

  it("withholds nothing until the company switches withholding on", async () => {
    expect(await getPurchaseSettings(as.auditor)).toEqual({ withholdingOn: false });
    expect((await getBillChoices(as.accountant, BILLED)).withholding).toEqual([]);
    const [helmets] = await received(company, [{ itemId: helmet, quantity: "100", unitCost: "1000" }]);
    await expect(saveBillDraft(as.accountant, null, bill(company, { incomeTaxCode: "income_tax.goods.company", goods: [{ receiptLineId: helmets, quantity: "100", unitPrice: "1000" }] }))).rejects.toThrow("Your company does not withhold tax from suppliers.");
    await expect(setWithholding(as.auditor, true)).rejects.toThrow("Only an owner or an accountant can change whether the company withholds tax.");
    await setWithholding(as.accountant, true);
    expect(await getPurchaseSettings(as.owner)).toEqual({ withholdingOn: true });
    const choices = await getBillChoices(as.accountant, BILLED);
    expect(choices.withholding.filter((line) => line.kind === "income_tax").map((line) => line.code)).toContain("income_tax.goods.company");
    expect(choices.withholding.filter((line) => line.kind === "provincial_sales_tax")).toHaveLength(4);
    const [{ action, after }] = await admin`select action, after from public.audit_log where tenant_id = ${tenantA} and entity = 'purchase_settings'`;
    expect([action, after]).toEqual(["purchase_settings.update", { withholdingOn: true }]);
  });

  it("the plan's test: a Rs 100,000 goods bill from a company that is not on the Active Taxpayers List withholds 10%, to the withholding payable account", async () => {
    const [line] = await listReceiptLinesToBill(as.accountant, company, mainBranch);
    const draft = await saveBillDraft(as.accountant, null, bill(company, { incomeTaxCode: "income_tax.goods.company", goods: [{ receiptLineId: line.receiptLineId, quantity: "100", unitPrice: "1000" }] }));
    // The draft shows what posting it will withhold.
    const preview = (await getBill(as.accountant, draft.id))!.preview;
    expect(preview?.ok && [preview.figures.total.toFixed(2), preview.figures.withheldTotal.toFixed(2), preview.figures.payable.toFixed(2)]).toEqual(["100000.00", "10000.00", "90000.00"]);
    const { number } = await postBill(as.accountant, draft.id, draft.updatedAt);
    expect(await journalLines(draft.id)).toEqual(["2120 Goods received not invoiced: 100000 / 0", "2210 Income tax withheld payable: 0 / 10000", "2110 Trade payables: 0 / 90000"]);
    const done = await getBill(as.auditor, draft.id);
    expect([done!.number, done!.total.toFixed(2), done!.withheld.toFixed(2), done!.payable.toFixed(2)]).toEqual([number, "100000.00", "10000.00", "90000.00"]);
    expect(done!.entries.map((e) => `${e.kind} ${e.code} on the list: ${e.onActiveList}; ${e.base.toFixed(2)} at ${e.rate}% = ${e.amount.toFixed(2)}`)).toEqual(["income_tax income_tax.goods.company on the list: false; 100000.00 at 10% = 10000.00"]);
    expect(done!.entries[0].legalReference).toContain("s.153(1)(a)");
    expect(await balance("wht_income_tax")).toBe("10000.00");
    // The same bill from the same company once it is on the list: 5%.
    await admin`update public.suppliers set atl_status = 'active', atl_checked_at = now() where tenant_id = ${tenantA} and id = ${company}`;
    const [helmets] = await received(company, [{ itemId: helmet, quantity: "100", unitCost: "1000" }]);
    const listed = await posted(bill(company, { incomeTaxCode: "income_tax.goods.company", goods: [{ receiptLineId: helmets, quantity: "100", unitPrice: "1000" }] }));
    expect(await journalLines(listed.id)).toEqual(["2120 Goods received not invoiced: 100000 / 0", "2210 Income tax withheld payable: 0 / 5000", "2110 Trade payables: 0 / 95000"]);
    // An AOP's line is another line of the table, and a line of another kind is not taken in its place.
    const [grips] = await received(plain, [{ itemId: grip, quantity: "10", unitCost: "40" }]);
    await expect(saveBillDraft(as.accountant, null, bill(plain, { incomeTaxCode: "sales_tax.active_taxpayer", goods: [{ receiptLineId: grips, quantity: "10", unitPrice: "40" }] }))).rejects.toThrow("Choose the withholding lines from the lists.");
    const aop = await posted(bill(plain, { incomeTaxCode: "income_tax.goods.non_company", goods: [{ receiptLineId: grips, quantity: "10", unitPrice: "40" }] }));
    // 11% of 400 from an AOP that is not on the list.
    expect(await journalLines(aop.id)).toEqual(["2120 Goods received not invoiced: 400 / 0", "2210 Income tax withheld payable: 0 / 44", "2110 Trade payables: 0 / 356"]);
  });

  it("claims input tax from a supplier registered with an STRN, and withholds sales tax and income tax on the bill", async () => {
    const [helmets] = await received(registered, [{ itemId: helmet, quantity: "10", unitCost: "1000" }]);
    // 10,000 of goods at 18%: 1,800 input tax. A fifth of the tax is withheld (360), and 5% income tax of the 11,800 (590).
    const taxed = await posted(bill(registered, { incomeTaxCode: "income_tax.goods.company", salesTaxCode: "sales_tax.active_taxpayer", goods: [{ receiptLineId: helmets, quantity: "10", unitPrice: "1000", taxCategoryId: standard }] }));
    expect(await journalLines(taxed.id)).toEqual([
      "2120 Goods received not invoiced: 10000 / 0",
      "1400 Sales tax receivable (input tax): 1800 / 0",
      "2210 Income tax withheld payable: 0 / 590",
      "2220 Sales tax withheld payable: 0 / 360",
      "2110 Trade payables: 0 / 10850",
    ]);
    const done = await getBill(as.owner, taxed.id);
    expect([done!.amount.toFixed(2), done!.salesTax.toFixed(2), done!.total.toFixed(2), done!.withheld.toFixed(2), done!.payable.toFixed(2)]).toEqual(["10000.00", "1800.00", "11800.00", "950.00", "10850.00"]);
    expect(done!.lines.map((l) => `${l.taxRate}% ${l.salesTax.toFixed(2)}`)).toEqual(["18% 1800.00"]);
    expect(done!.entries.map((e) => `${e.kind}: ${e.base.toFixed(2)} at ${e.rate}% = ${e.amount.toFixed(2)}`)).toEqual(["income_tax: 11800.00 at 5% = 590.00", "sales_tax: 1800.00 at 20% = 360.00"]);
    // No input tax from a supplier who is not registered, whatever is typed.
    const [more] = await received(company, [{ itemId: grip, quantity: "5", unitCost: "40" }]);
    await expect(saveBillDraft(as.accountant, null, bill(company, { goods: [{ receiptLineId: more, quantity: "5", unitPrice: "40", taxCategoryId: standard }] }))).rejects.toThrow("sales tax can be entered only when your company is registered for sales tax and the supplier is registered with an STRN");
    // Nor a sales tax line where there is no sales tax to withhold from.
    await expect(saveBillDraft(as.accountant, null, bill(company, { salesTaxCode: "sales_tax.active_taxpayer", goods: [{ receiptLineId: more, quantity: "5", unitPrice: "40" }] }))).rejects.toThrow("There is nothing on the bill for the sales tax line to be withheld from.");
    // Written past the app: a tax the rate does not give is refused when the bill is posted.
    const forged = await saveBillDraft(as.accountant, null, bill(registered, {}));
    const [again] = await received(registered, [{ itemId: grip, quantity: "5", unitCost: "40" }]);
    expect(await codeOf(as.accountant, sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, receipt_line_id, item_id, description, quantity, unit_price, amount, tax_category_id, tax_rate, sales_tax, created_by)
      values (${tenantA}, ${forged.id}, 1, 'goods', ${again}, ${grip}, 'Grip', 5, 40, 200, ${standard}, 50, 100, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`update public.supplier_bills set amount = 200, sales_tax = 100, total = 300, updated_by = ${userIds.accountant} where id = ${forged.id}`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_bill(${forged.id}::uuid)`)).toBe("SE227");
    await discardBill(as.accountant, forged.id);
  });

  it("bills a service with the province's tax on it: the tax is charged, withheld whole, and income tax is withheld on the gross", async () => {
    // Freight of 50,000 from an AOP not on the list, in Punjab: 16% provincial tax (8,000), and 28% income tax of the 58,000.
    const service = await posted(bill(plain, { incomeTaxCode: "income_tax.services.other", provincialTaxCode: "provincial_sales_tax.punjab", expenses: [{ accountId: freight, description: "Freight, Lahore to Multan", amount: "30000" }, { accountId: freight, description: "Loading", amount: "20000" }] }));
    expect(await journalLines(service.id)).toEqual([
      "5260 Freight and cartage outward: 34800 / 0",
      "5260 Freight and cartage outward: 23200 / 0",
      "2210 Income tax withheld payable: 0 / 16240",
      "2230 Provincial sales tax withheld payable: 0 / 8000",
      "2110 Trade payables: 0 / 33760",
    ]);
    const done = await getBill(as.owner, service.id);
    expect([done!.amount.toFixed(2), done!.provincialTax.toFixed(2), done!.total.toFixed(2), done!.withheld.toFixed(2), done!.payable.toFixed(2)]).toEqual(["50000.00", "8000.00", "58000.00", "24240.00", "33760.00"]);
    // The province's tax is on services: a bill of goods alone has none.
    const [grips] = await received(plain, [{ itemId: grip, quantity: "2", unitCost: "40" }]);
    await expect(saveBillDraft(as.accountant, null, bill(plain, { provincialTaxCode: "provincial_sales_tax.sindh", goods: [{ receiptLineId: grips, quantity: "2", unitPrice: "40" }] }))).rejects.toThrow("The province's tax is on services.");
    // An expense is charged to an account that takes plain entries, not a locked one.
    const [{ id: payables }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '2110'`;
    await expect(saveBillDraft(as.accountant, null, bill(plain, { expenses: [{ accountId: payables, description: "x", amount: "10" }] }))).rejects.toThrow("A bill can charge an expense or asset account that takes plain entries");
  });

  it("keeps the books agreeing with what was received, billed and withheld", async () => {
    const [entries] = await admin<{ income: string; sales: string; provincial: string }[]>`
      select coalesce(sum(amount) filter (where kind = 'income_tax'), 0)::numeric(20,2)::text as income, coalesce(sum(amount) filter (where kind = 'sales_tax'), 0)::numeric(20,2)::text as sales,
             coalesce(sum(amount) filter (where kind = 'provincial_sales_tax'), 0)::numeric(20,2)::text as provincial
      from public.withholding_entries where tenant_id = ${tenantA}`;
    expect([await balance("wht_income_tax"), await balance("wht_sales_tax"), await balance("wht_provincial_tax")]).toEqual([entries.income, entries.sales, entries.provincial]);
    const [{ payable }] = await admin<{ payable: string }[]>`select coalesce(sum(payable), 0)::numeric(20,2)::text as payable from public.supplier_bills where tenant_id = ${tenantA} and status = 'posted'`;
    expect(await balance("ap")).toBe(payable);
    const grni = await getGrni(as.auditor);
    expect(grni.total.toFixed(2)).toBe(grni.ledger.toFixed(2));
    expect((await listBills(as.auditor)).rows.every((row) => row.status === "posted" && row.payable.eq(row.total.minus(row.withheld)))).toBe(true);
  });

  it("lets the app's role write nothing that only the posting function may write, and keeps bills to those who keep the books", async () => {
    const [helmets] = await received(plain, [{ itemId: helmet, quantity: "3", unitCost: "600" }]);
    const draft = await saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: helmets, quantity: "1", unitPrice: "600" }] }));
    const [done] = await admin<{ id: string; journal_id: string }[]>`select id, journal_id from public.supplier_bills where tenant_id = ${tenantA} and status = 'posted' limit 1`;
    const me = userIds.owner;
    // A bill's status, number, journal, what was withheld and what is owed.
    for (const change of [sql`status = 'posted'`, sql`number = 'PB-2627-99999'`, sql`journal_id = ${done.journal_id}`, sql`withheld = 1`, sql`payable = 1`]) {
      expect(await codeOf(as.owner, sql`update public.supplier_bills set ${change} where id = ${draft.id}`)).toBe("42501");
    }
    expect(await codeOf(as.owner, sql`insert into public.supplier_bills (tenant_id, status, number, bill_date, supplier_id, branch_id, supplier_invoice_no, created_by, updated_by) values (${tenantA}, 'posted', 'PB-2627-88888', ${BILLED}, ${plain}, ${mainBranch}, 'X', ${me}, ${me})`)).toBe("SE224");
    // A posted bill and its lines stay as they are.
    expect(await rowsOf(as.owner, sql`update public.supplier_bills set note = 'changed', updated_by = ${me} where id = ${done.id} returning 1`)).toBe(0);
    expect(await codeOf(as.owner, sql`delete from public.supplier_bills where id = ${done.id}`)).toBeUndefined();
    expect(await rowsOf(as.owner, sql`select 1 from public.supplier_bills where id = ${done.id}`)).toBe(1);
    expect(await codeOf(as.owner, sql`update public.supplier_bill_lines set received_value = 1 where bill_id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, account_id, description, amount, created_by) values (${tenantA}, ${done.id}, 9, 'expense', ${freight}, 'x', 5, ${me})`)).toBe("SE226");
    expect(await codeOf(as.owner, sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, receipt_line_id, item_id, description, quantity, unit_price, amount, received_value, created_by) values (${tenantA}, ${draft.id}, 9, 'goods', ${helmets}, ${helmet}, 'x', 1, 1, 1, 1, ${me})`)).toBe("SE226");
    // Goods of another supplier, or more than arrived, are not a line of this bill.
    const [theirs] = await received(company, [{ itemId: helmet, quantity: "1", unitCost: "600" }]);
    const goods = (receiptLine: string, quantity: number) => sql`insert into public.supplier_bill_lines (tenant_id, bill_id, line_no, kind, receipt_line_id, item_id, description, quantity, unit_price, amount, created_by) values (${tenantA}, ${draft.id}, 8, 'goods', ${receiptLine}, ${helmet}, 'x', ${quantity}, 1, ${quantity}, ${me})`;
    expect(await codeOf(as.owner, goods(theirs, 1)), "another supplier's goods").toBe("SE226");
    expect(await codeOf(as.owner, goods(helmets, 4)), "more than arrived").toBe("SE226");
    // What was withheld is the database's alone: never written, changed or removed by the app's role.
    expect(await codeOf(as.owner, sql`insert into public.withholding_entries (tenant_id, bill_id, supplier_id, entry_date, kind, rule_id, code, legal_reference, on_active_list, base_amount, rate, amount, journal_id, created_by) select tenant_id, bill_id, supplier_id, entry_date, 'sales_tax', rule_id, code, legal_reference, on_active_list, base_amount, rate, amount, journal_id, created_by from public.withholding_entries limit 1`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.withholding_entries set amount = 1`)).toBe("42501");
    expect(await codeOf(as.owner, sql`delete from public.withholding_entries`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id) values (${tenantA}, ${me}, 'owner', 'supplier_bill.post', 'x', ${draft.id})`)).toBeDefined();
    // The journal of a bill is not removed or reversed by the app's role.
    expect(await codeOf(as.owner, sql`delete from public.journals where id = ${done.journal_id}`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.reverse_journal(${done.journal_id}::uuid, ${BILLED}::date, 'undo')`)).toBeDefined();

    // Bills are for the owner and whoever keeps or checks the books; the auditor only reads.
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(listBills(as[role]), role).rejects.toThrow("Your role does not include supplier bills.");
      expect(await rowsOf(as[role], sql`select 1 from public.supplier_bills`), role).toBe(0);
      expect(await rowsOf(as[role], sql`select 1 from public.withholding_entries`), role).toBe(0);
      expect(await codeOf(as[role], sql`select app.post_supplier_bill(${draft.id}::uuid)`), role).toBe("42501");
    }
    await expect(saveBillDraft(as.auditor, null, bill(plain, {}))).rejects.toThrow("Only an owner or an accountant can write supplier bills.");
    expect(await codeOf(as.auditor, sql`select app.post_supplier_bill(${draft.id}::uuid)`)).toBe("42501");
    // An accountant of the north branch does not see, change or post the main branch's bills.
    expect(await getBill(north, draft.id)).toBeNull();
    expect((await listBills(north)).rows).toEqual([]);
    await expect(postBill(north, draft.id)).rejects.toThrow("That supplier bill is not in this company.");
    expect(await codeOf(north, sql`select app.post_supplier_bill(${draft.id}::uuid)`)).toBe("SE223");
    await expect(saveBillDraft(north, null, bill(plain, {}))).rejects.toThrow("Choose the branch from your own branches.");
    // Another company sees nothing of it.
    expect(await rowsOf(otherOwner, sql`select 1 from public.supplier_bills`)).toBe(0);
    expect(await codeOf(otherOwner, sql`select app.post_supplier_bill(${draft.id}::uuid)`)).toBe("SE223");
    await discardBill(as.accountant, draft.id);
    expect(await getBill(as.accountant, draft.id)).toBeNull();
  });

  it("posts one bill for the same goods when two are posted at the same moment", async () => {
    for (let round = 0; round < 4; round += 1) {
      const [grips] = await received(plain, [{ itemId: grip, quantity: "5", unitCost: "40" }]);
      const drafts = await Promise.all([0, 1].map(() => saveBillDraft(as.accountant, null, bill(plain, { goods: [{ receiptLineId: grips, quantity: "5", unitPrice: "40" }] }))));
      const results = await Promise.allSettled(drafts.map((draft, index) => postBill(index === 0 ? as.accountant : as.owner, draft.id)));
      expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
      for (const [index, result] of results.entries()) if (result.status === "rejected") await discardBill(as.owner, drafts[index].id);
    }
    const grni = await getGrni(as.auditor);
    expect(grni.total.toFixed(2)).toBe(grni.ledger.toFixed(2));
  });
});
