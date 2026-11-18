import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { addCurrency, setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { applyAdvance, cancelPayment, discardPayment, postPayment, recordChallan, savePaymentDraft } from "./commands";
import { getPayment, getPaymentChoices, getWithholdingPosition, listBillsOwed, listPayments } from "./queries";
import type { RawPayment } from "./rules";

// Supplier payments, advances and challans against a real database, through the app's own
// path (app_runtime, withTenant, row-level security): what each posts, what is refused, and
// that the books always agree with what is owed to suppliers, what was paid in advance and
// what tax is still to be paid over. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-payment-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@payment.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [mainBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const ORDERED = "2026-11-02";
const ARRIVED = "2026-11-03";
const BILLED = "2026-11-04";
const PAID = "2026-11-06";

let admin: AdminSql;
/** An AOP: nothing is withheld on its bills here. */
let plain = "";
/** A company that is not on the Active Taxpayers List: 10% income tax is withheld on its goods. */
let company = "";
let helmet = "";
let bank = "";
let cash = "";
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
/** The balance of a locked account, as a liability (credit less debit) or, for an asset, the other way. */
const balance = async (control: string, asset = false) => {
  const [{ v }] = await admin<{ v: string }[]>`
    select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantA} and a.control_type = ${control}`;
  return asset ? (0 - Number(v)).toFixed(2) : v;
};
const moneyOut = async (accountId: string) =>
  (await admin<{ v: string }[]>`select coalesce(sum(credit - debit), 0)::numeric(20,2)::text as v from public.journal_lines where tenant_id = ${tenantA} and account_id = ${accountId}`)[0].v;

/** Helmets ordered from a supplier, received in full and billed in full: the posted bill. */
async function billed(supplierId: string, quantity: string, unitCost: string, incomeTaxCode?: string): Promise<{ id: string; number: string }> {
  const order = await saveOrderDraft(as.owner, null, { date: ORDERED, supplierId, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity, unitCost }] });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveReceiptDraft(as.warehouse_manager, null, order.id, { date: ARRIVED, lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postReceipt(as.warehouse_manager, note.id);
  const [{ id: receiptLineId }] = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id}`;
  const draft = await saveBillDraft(as.accountant, null, { date: BILLED, supplierId, branchId: mainBranch, supplierInvoiceNo: `INV-${(invoiceNo += 1)}`, incomeTaxCode, goods: [{ receiptLineId, quantity, unitPrice: unitCost }] });
  return { id: draft.id, ...(await postBill(as.accountant, draft.id)) };
}
const payment = (supplierId: string, over: Partial<RawPayment>): RawPayment => ({ date: PAID, supplierId, branchId: mainBranch, accountId: bank, amount: "0", ...over });
/** A payment saved and posted by the accountant. */
async function paid(raw: RawPayment, who: TenantContext = as.accountant): Promise<{ id: string; number: string }> {
  const { id, updatedAt } = await savePaymentDraft(who, null, raw);
  return { id, ...(await postPayment(who, id, updatedAt)) };
}
const owed = async (supplierId: string) => (await listBillsOwed(as.accountant, supplierId, mainBranch)).map((bill) => `${bill.number}: ${bill.owed.toFixed(2)} of ${bill.payable.toFixed(2)}`);

describe.skipIf(!hasDb)("supplier payments, advances and challans", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      // An accountant who works in the main branch only: pays its suppliers, but records no challan.
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [mainBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await addCurrency(as.owner, { code: "USD", name: "US Dollar" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    cash = await account("1111");
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1500" })).id;
    plain = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    company = (await createParty(as.owner, "supplier", { name: "Karachi Motors (Pvt) Ltd", supplierType: "company" })).id;
    await setWithholding(as.owner, true);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("pays bills out of a bank account: what is owed to the supplier comes down, and no bill is paid more than is owed on it", async () => {
    const first = await billed(plain, "4", "600");
    const second = await billed(plain, "6", "650");
    expect(await owed(plain)).toEqual([`${first.number}: 2400.00 of 2400.00`, `${second.number}: 3900.00 of 3900.00`]);
    expect((await getPaymentChoices(as.accountant)).accounts.map((a) => a.label)).toEqual(["1111 Cash in hand", expect.stringContaining("HBL current account")]);
    // Not more against a bill than is owed on it, not more against bills than the payment, not a bill dated after the payment.
    await expect(savePaymentDraft(as.accountant, null, payment(plain, { amount: "5000", allocations: [{ billId: first.id, amount: "2400.01" }] }))).rejects.toThrow(`${first.number}: 2400.00 is still owed on it, so 2400.01 cannot be set against it.`);
    await expect(savePaymentDraft(as.accountant, null, payment(plain, { amount: "3000", allocations: [{ billId: first.id, amount: "2400" }, { billId: second.id, amount: "1000" }] }))).rejects.toThrow("3400.00 is set against bills, more than the payment: 3000.00.");
    await expect(savePaymentDraft(as.accountant, null, payment(plain, { date: "2026-11-03", amount: "100", allocations: [{ billId: first.id, amount: "100" }] }))).rejects.toThrow("Money paid before a bill is an advance");
    await expect(savePaymentDraft(as.warehouse_manager, null, payment(plain, { amount: "100" }))).rejects.toThrow("Only an owner or an accountant can pay suppliers.");

    const draft = await savePaymentDraft(as.accountant, null, payment(plain, { amount: "3400", reference: "CHQ 001122", allocations: [{ billId: first.id, amount: "2400" }, { billId: second.id, amount: "1000" }] }));
    // A draft pays nothing.
    expect(await owed(plain)).toHaveLength(2);
    expect(await moneyOut(bank)).toBe("0.00");
    await expect(postPayment(as.accountant, draft.id, new Date(draft.updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this payment after you opened it.");
    expect(await postPayment(as.accountant, draft.id, draft.updatedAt)).toEqual({ number: "PV-2627-00001" });
    const done = await getPayment(as.auditor, draft.id);
    expect(done).toMatchObject({ status: "posted", number: "PV-2627-00001", supplierName: "Lahore Parts", reference: "CHQ 001122" });
    expect([done!.amount.toFixed(2), done!.settled.toFixed(2), done!.advance.toFixed(2)]).toEqual(["3400.00", "3400.00", "0.00"]);
    expect(await journalOf(done!.journalId)).toEqual(["2110 Trade payables: 3400 / 0", expect.stringMatching(/HBL current account: 0 \/ 3400$/)]);
    // The first bill is paid; 2,900 is still owed on the second.
    expect(await owed(plain)).toEqual([`${second.number}: 2900.00 of 3900.00`]);
    expect(await balance("ap")).toBe("2900.00");
    // A posted payment is not changed, thrown away or posted twice.
    await expect(savePaymentDraft(as.owner, draft.id, payment(plain, { amount: "1" }))).rejects.toThrow("This payment is posted and cannot be changed.");
    await expect(discardPayment(as.owner, draft.id)).rejects.toThrow("This payment is posted and cannot be removed.");
    await expect(postPayment(as.owner, draft.id)).rejects.toThrow("This payment is already posted.");
    // Written past the app: a draft that settles more than is now owed is refused when posted.
    const over = await savePaymentDraft(as.accountant, null, payment(plain, { amount: "3900", accountId: cash }));
    expect(await codeOf(as.accountant, sql`insert into public.supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, created_by) values (${tenantA}, ${over.id}, ${second.id}, 3900, ${userIds.accountant})`)).toBeUndefined();
    expect(await codeOf(as.accountant, sql`select app.post_supplier_payment(${over.id}::uuid)`)).toBe("SE239");
    await discardPayment(as.accountant, over.id);
    const audited = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'supplier_payment' and entity_id = ${draft.id} order by at, id`;
    expect(audited.map((row) => row.action)).toEqual(["supplier_payment.create", "supplier_payment.post"]);
  });

  it("the plan's test: a bill paid with an advance set against it and the rest in money nets to nothing owed", async () => {
    // 50,000 sent ahead to Karachi Motors, who are abroad for this purpose: USD 178.57 at the day's rate. Nothing is billed yet, so all of it is an advance.
    const advance = await paid(payment(company, { date: "2026-11-01", amount: "50000", foreignCurrency: "usd", foreignAmount: "178.57", note: "Proforma 44" }));
    const sent = await getPayment(as.accountant, advance.id);
    expect([sent!.foreignCurrency, sent!.foreignAmount?.toFixed(2), sent!.settled.toFixed(2), sent!.advance.toFixed(2)]).toEqual(["USD", "178.57", "0.00", "50000.00"]);
    expect(await journalOf(sent!.journalId)).toEqual(["1210 Advances to suppliers: 50000 / 0", expect.stringMatching(/HBL current account: 0 \/ 50000$/)]);
    expect(await balance("supplier_advances", true)).toBe("50000.00");
    // The goods arrive and are billed: 100,000, of which 10% income tax is withheld and 90,000 is owed.
    const bill = await billed(company, "100", "1000", "income_tax.goods.company");
    expect(await owed(company)).toEqual([`${bill.number}: 90000.00 of 90000.00`]);
    // The advance is set against the bill: it cannot be before the bill's day, nor for more than the advance.
    await expect(applyAdvance(as.accountant, advance.id, { date: "2026-11-03", allocations: [{ billId: bill.id, amount: "50000" }] })).rejects.toThrow("Money paid before a bill is an advance");
    await expect(applyAdvance(as.accountant, advance.id, { date: PAID, allocations: [{ billId: bill.id, amount: "50000.01" }] })).rejects.toThrow("50000.01 is set against bills, more than what is left of the advance: 50000.00.");
    expect(await applyAdvance(as.accountant, advance.id, { date: PAID, allocations: [{ billId: bill.id, amount: "50000" }] })).toEqual({ bills: 1 });
    const applied = await getPayment(as.accountant, advance.id);
    expect(applied!.allocations.map((a) => `${a.billNumber} ${a.amount.toFixed(2)} on ${a.appliedOn}`)).toEqual([`${bill.number} 50000.00 on ${PAID}`]);
    expect(applied!.advance.toFixed(2)).toBe("0.00");
    const [{ journal_id: applicationJournal }] = await admin<{ journal_id: string }[]>`select journal_id from public.supplier_payment_allocations where tenant_id = ${tenantA} and payment_id = ${advance.id}`;
    expect(await journalOf(applicationJournal)).toEqual(["2110 Trade payables: 50000 / 0", "1210 Advances to suppliers: 0 / 50000"]);
    expect(await owed(company)).toEqual([`${bill.number}: 40000.00 of 90000.00`]);
    await expect(applyAdvance(as.accountant, advance.id, { date: PAID, allocations: [{ billId: bill.id, amount: "1" }] })).rejects.toThrow("1.00 is set against bills, more than what is left of the advance: 0.00.");
    // The rest is paid in money.
    const rest = await paid(payment(company, { amount: "40000", allocations: [{ billId: bill.id, amount: "40000" }] }));
    expect(await journalOf((await getPayment(as.accountant, rest.id))!.journalId)).toEqual(["2110 Trade payables: 40000 / 0", expect.stringMatching(/HBL current account: 0 \/ 40000$/)]);
    // It nets: nothing is owed on the bill, no advance is left, 90,000 went out, and 10,000 is owed to the government.
    expect(await owed(company)).toEqual([]);
    const [{ v: owedToCompany }] = await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type in ('ap', 'supplier_advances') and l.supplier_id = ${company}`;
    expect(owedToCompany).toBe("0.00");
    expect(await balance("supplier_advances", true)).toBe("0.00");
    expect(await balance("wht_income_tax")).toBe("10000.00");
    // More than is owed is never taken by a bill: money beyond it stays an advance.
    const extra = await paid(payment(company, { amount: "700", accountId: cash }));
    expect((await getPayment(as.auditor, extra.id))!.advance.toFixed(2)).toBe("700.00");
    expect((await listPayments(as.auditor)).rows.map((row) => `${row.number} ${row.status} ${row.amount.toFixed(2)} advance ${row.advance.toFixed(2)}`)).toEqual([
      "PV-2627-00004 posted 700.00 advance 700.00",
      "PV-2627-00003 posted 40000.00 advance 0.00",
      "PV-2627-00001 posted 3400.00 advance 0.00",
      "PV-2627-00002 posted 50000.00 advance 0.00",
    ]);
  });

  it("takes a payment back as it stands: everything it posted is reversed and its bills are owed again", async () => {
    const bill = await billed(plain, "2", "500");
    const mistaken = await paid(payment(plain, { amount: "1500", allocations: [{ billId: bill.id, amount: "600" }] }));
    // 600 settled as it went out; 900 left as an advance, of which 400 is then set against the same bill.
    await applyAdvance(as.accountant, mistaken.id, { date: "2026-11-08", allocations: [{ billId: bill.id, amount: "400" }] });
    // Nothing is owed on the bill now.
    expect((await owed(plain)).some((row) => row.startsWith(bill.number))).toBe(false);
    const before = { ap: await balance("ap"), advances: await balance("supplier_advances", true), bank: await moneyOut(bank) };
    await expect(cancelPayment(as.auditor, mistaken.id, { date: "2026-11-08", reason: "Paid twice" })).rejects.toThrow("Only an owner or an accountant can pay suppliers.");
    await expect(cancelPayment(as.accountant, mistaken.id, { date: "2026-11-08", reason: " " })).rejects.toThrow("Say why the payment is cancelled, in a few words.");
    await expect(cancelPayment(as.accountant, mistaken.id, { date: "2026-11-07", reason: "Paid twice" })).rejects.toThrow("It cannot be cancelled before that day.");
    await cancelPayment(as.accountant, mistaken.id, { date: "2026-11-09", reason: "Paid twice" });
    const gone = await getPayment(as.auditor, mistaken.id);
    expect(gone).toMatchObject({ status: "cancelled", number: mistaken.number, cancelledOn: "2026-11-09", cancelReason: "Paid twice" });
    // The bill is owed in full again; the bank has its 1,500 back; payables are 1,000 higher; the advance is gone.
    expect((await owed(plain)).at(-1)).toBe(`${bill.number}: 1000.00 of 1000.00`);
    expect(Number(await balance("ap")) - Number(before.ap)).toBe(1000);
    expect(Number(before.advances) - Number(await balance("supplier_advances", true))).toBe(500);
    expect(Number(before.bank) - Number(await moneyOut(bank))).toBe(1500);
    const reversals = await admin<{ n: number }[]>`select count(*)::int as n from public.journals where tenant_id = ${tenantA} and source_type = 'reversal' and journal_date = '2026-11-09'`;
    expect(reversals[0].n).toBe(2);
    await expect(cancelPayment(as.accountant, mistaken.id, { date: "2026-11-09", reason: "Paid twice" })).rejects.toThrow("This payment is already cancelled.");
    await expect(applyAdvance(as.accountant, mistaken.id, { date: "2026-11-09", allocations: [{ billId: bill.id, amount: "1" }] })).rejects.toThrow("This payment was cancelled.");
    expect(await codeOf(as.accountant, sql`select app.cancel_supplier_payment(${mistaken.id}::uuid, '2026-11-09'::date, 'again')`)).toBe("SE236");
  });

  it("records a challan: tax withheld is paid to the government, whole entries of one kind, each once", async () => {
    // A second bill with tax withheld, so there are two entries of income tax to pay.
    await billed(company, "10", "1000", "income_tax.goods.company");
    const position = await getWithholdingPosition(as.accountant);
    expect(position.unpaid.map((e) => `${e.kind} ${e.supplierName} ${e.amount.toFixed(2)}`)).toEqual(["income_tax Karachi Motors (Pvt) Ltd 10000.00", "income_tax Karachi Motors (Pvt) Ltd 1000.00"]);
    const [big, small] = position.unpaid.map((e) => e.entryId);
    const challan = { kind: "income_tax", paidOn: "2026-11-10", accountId: bank, challanNo: "IT-20261110-0001", entryIds: [big] };
    await expect(recordChallan(as.auditor, challan)).rejects.toThrow("Only an owner or an accountant can record a challan.");
    await expect(recordChallan(north, challan)).rejects.toThrow("only someone who works in every branch can record one");
    await expect(recordChallan(as.accountant, { ...challan, kind: "sales_tax" })).rejects.toThrow("A challan pays whole amounts withheld, of its own kind of tax");
    await expect(recordChallan(as.accountant, { ...challan, paidOn: "2026-11-03" })).rejects.toThrow("A challan pays whole amounts withheld");
    await expect(recordChallan(as.accountant, { ...challan, entryIds: [] })).rejects.toThrow("Tick the amounts withheld that this challan paid.");
    expect(await recordChallan(as.accountant, challan)).toEqual({ number: "WC-2627-00001" });
    const after = await getWithholdingPosition(as.auditor);
    expect(after.unpaid.map((e) => e.amount.toFixed(2))).toEqual(["1000.00"]);
    expect(after.challans.map((c) => `${c.number} ${c.kind} ${c.challanNo} ${c.paidOn} ${c.amount.toFixed(2)} for ${c.entries}`)).toEqual(["WC-2627-00001 income_tax IT-20261110-0001 2026-11-10 10000.00 for 1"]);
    expect(await journalOf(after.challans[0].journalId)).toEqual(["2210 Income tax withheld payable: 10000 / 0", expect.stringMatching(/HBL current account: 0 \/ 10000$/)]);
    // What the account holds is what is still to be paid over.
    expect(await balance("wht_income_tax")).toBe("1000.00");
    // An entry is paid once: not again alone, not again beside another.
    await expect(recordChallan(as.accountant, { ...challan, challanNo: "IT-2" })).rejects.toThrow("A challan pays whole amounts withheld");
    await expect(recordChallan(as.accountant, { ...challan, challanNo: "IT-2", entryIds: [big, small] })).rejects.toThrow("A challan pays whole amounts withheld");
    expect(await codeOf(as.accountant, sql`select app.record_withholding_challan('income_tax', '2026-11-10'::date, ${bank}::uuid, 'IT-3', ARRAY[${small}, ${small}]::uuid[])`)).toBe("SE243");
    // Money for a challan leaves a cash or bank account, not any account.
    const [{ id: payables }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '2110'`;
    expect(await codeOf(as.accountant, sql`select app.record_withholding_challan('income_tax', '2026-11-10'::date, ${payables}::uuid, 'IT-4', ARRAY[${small}]::uuid[])`)).toBe("SE241");
  });

  it("keeps the books agreeing with what is owed, what was paid ahead and what was withheld", async () => {
    const [sums] = await admin<{ owed: string; advances: string; unpaid: string }[]>`
      select
        (select coalesce(sum(b.payable), 0) from public.supplier_bills b where b.tenant_id = ${tenantA} and b.status = 'posted')
          - (select coalesce(sum(a.amount), 0) from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id where a.tenant_id = ${tenantA} and p.status = 'posted') as owed,
        (select coalesce(sum(p.amount), 0) from public.supplier_payments p where p.tenant_id = ${tenantA} and p.status = 'posted')
          - (select coalesce(sum(a.amount), 0) from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id where a.tenant_id = ${tenantA} and p.status = 'posted') as advances,
        (select coalesce(sum(e.amount), 0) from public.withholding_entries e where e.tenant_id = ${tenantA}
           and not exists (select 1 from public.withholding_challan_entries c where c.entry_id = e.id)) as unpaid`;
    expect(await balance("ap")).toBe(Number(sums.owed).toFixed(2));
    expect(await balance("supplier_advances", true)).toBe(Number(sums.advances).toFixed(2));
    expect(await balance("wht_income_tax")).toBe(Number(sums.unpaid).toFixed(2));
  });

  it("lets the app's role write nothing that only the functions may write, and keeps payments to those who keep the books", async () => {
    const bill = await billed(plain, "1", "300");
    const draft = await savePaymentDraft(as.accountant, null, payment(plain, { amount: "300", allocations: [{ billId: bill.id, amount: "300" }] }));
    const [done] = await admin<{ id: string; journal_id: string }[]>`select id, journal_id from public.supplier_payments where tenant_id = ${tenantA} and status = 'posted' limit 1`;
    const me = userIds.owner;
    // A payment's status, number and journal; who cancelled it and why.
    for (const change of [sql`status = 'posted'`, sql`number = 'PV-2627-99999'`, sql`journal_id = ${done.journal_id}`, sql`cancel_reason = 'x'`]) {
      expect(await codeOf(as.owner, sql`update public.supplier_payments set ${change} where id = ${draft.id}`)).toBe("42501");
    }
    expect(await codeOf(as.owner, sql`insert into public.supplier_payments (tenant_id, status, number, payment_date, supplier_id, branch_id, account_id, amount, created_by, updated_by) values (${tenantA}, 'posted', 'PV-2627-88888', ${PAID}, ${plain}, ${mainBranch}, ${bank}, 5, ${me}, ${me})`)).toBe("SE236");
    // A posted payment and what it settled stay as they are.
    expect(await rowsOf(as.owner, sql`update public.supplier_payments set note = 'changed', updated_by = ${me} where id = ${done.id} returning 1`)).toBe(0);
    expect(await codeOf(as.owner, sql`delete from public.supplier_payments where id = ${done.id}`)).toBeUndefined();
    expect(await rowsOf(as.owner, sql`select 1 from public.supplier_payments where id = ${done.id}`)).toBe(1);
    expect(await codeOf(as.owner, sql`delete from public.supplier_payment_allocations where payment_id = ${done.id}`)).toBeUndefined();
    expect(await rowsOf(as.owner, sql`select 1 from public.supplier_payment_allocations where payment_id = ${done.id}`)).toBeGreaterThan(0);
    expect(await codeOf(as.owner, sql`update public.supplier_payment_allocations set amount = 1 where payment_id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, created_by) values (${tenantA}, ${done.id}, ${bill.id}, 1, ${me})`)).toBe("SE238");
    // The app's role cannot say an advance was set against a bill: the day and the journal of that are not its to write.
    expect(await codeOf(as.owner, sql`insert into public.supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, applied_on, journal_id, created_by) values (${tenantA}, ${done.id}, ${bill.id}, 1, ${PAID}, ${done.journal_id}, ${me})`)).toBe("42501");
    // A bill of another supplier is not this payment's to settle.
    const theirs = await billed(company, "1", "100");
    expect(await codeOf(as.owner, sql`insert into public.supplier_payment_allocations (tenant_id, payment_id, bill_id, amount, created_by) values (${tenantA}, ${draft.id}, ${theirs.id}, 1, ${me})`)).toBe("SE238");
    // Challans are the database's alone.
    expect(await codeOf(as.owner, sql`insert into public.withholding_challans (tenant_id, number, kind, challan_no, paid_on, account_id, amount, journal_id, created_by) values (${tenantA}, 'WC-2627-99999', 'income_tax', 'x', ${PAID}, ${bank}, 1, ${done.journal_id}, ${me})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.withholding_challans set amount = 1`)).toBe("42501");
    expect(await codeOf(as.owner, sql`delete from public.withholding_challan_entries`)).toBe("42501");
    for (const action of ["supplier_payment.post", "supplier_payment.apply_advance", "supplier_payment.cancel", "withholding_challan.record"]) {
      expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id) values (${tenantA}, ${me}, 'owner', ${action}, 'x', ${draft.id})`), action).toBeDefined();
    }
    // A payment's journal is not removed or reversed by the app's role, and the helpers are not the app's to call.
    expect(await codeOf(as.owner, sql`delete from public.journals where id = ${done.journal_id}`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.reverse_journal(${done.journal_id}::uuid, ${PAID}::date, 'undo')`)).toBeDefined();
    expect(await codeOf(as.owner, sql`select app.reverse_payment_journal(${tenantA}::uuid, ${done.journal_id}::uuid, ${PAID}::date, 'undo')`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.bill_owed(${tenantA}::uuid, ${bill.id}::uuid)`)).toBe("42501");

    // Payments are for the owner and whoever keeps or checks the books; the auditor only reads.
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(listPayments(as[role]), role).rejects.toThrow("Your role does not include supplier payments.");
      expect(await rowsOf(as[role], sql`select 1 from public.supplier_payments`), role).toBe(0);
      expect(await rowsOf(as[role], sql`select 1 from public.withholding_challans`), role).toBe(0);
      expect(await codeOf(as[role], sql`select app.post_supplier_payment(${draft.id}::uuid)`), role).toBe("42501");
    }
    expect(await codeOf(as.auditor, sql`select app.post_supplier_payment(${draft.id}::uuid)`)).toBe("42501");
    expect(await codeOf(as.auditor, sql`select app.cancel_supplier_payment(${done.id}::uuid, ${PAID}::date, 'because')`)).toBe("42501");
    // Another company sees nothing of it.
    expect(await rowsOf(otherOwner, sql`select 1 from public.supplier_payments`)).toBe(0);
    expect(await codeOf(otherOwner, sql`select app.post_supplier_payment(${draft.id}::uuid)`)).toBe("SE235");
    await discardPayment(as.accountant, draft.id);
    expect(await getPayment(as.accountant, draft.id)).toBeNull();
  });

  it("pays a bill once when two payments for it are posted at the same moment", async () => {
    for (let round = 0; round < 4; round += 1) {
      const bill = await billed(plain, "1", "250");
      const drafts = await Promise.all([0, 1].map(() => savePaymentDraft(as.accountant, null, payment(plain, { amount: "250", accountId: cash, allocations: [{ billId: bill.id, amount: "250" }] }))));
      const results = await Promise.allSettled(drafts.map((draft, index) => postPayment(index === 0 ? as.accountant : as.owner, draft.id)));
      expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
      for (const [index, result] of results.entries()) if (result.status === "rejected") await discardPayment(as.owner, drafts[index].id);
      expect((await listBillsOwed(as.accountant, plain, mainBranch)).some((row) => row.billId === bill.id)).toBe(false);
    }
  });
});
