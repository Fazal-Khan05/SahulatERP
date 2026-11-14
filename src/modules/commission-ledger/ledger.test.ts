import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { savePlan, setManager } from "@/modules/commissions/commands";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { bounceCheque, cancelReceipt, clearCheque, depositCheque, postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { approveCommission, payCommission } from "./commands";
import { getEarned, getInvoiceCommission, listMovements, listPayments } from "./queries";

// Commission against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): the old prototype's workflow tests (COM-016 onwards, COL-100), ported by
// hand, with what the founder changed (a cheque releases when it clears; a return comes off the
// month's sales; the owner and an accountant approve; what is owed back comes out of later
// commission), managers' shares, and what the app's role may not do. The figures of the worked
// example are those of docs/examples/step-38.md. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-commission-ledger-test";
const tenantA = randomUUID(); // not registered for sales tax
const tenantT = randomUUID(); // registered: 18% on every line
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
// Salespeople: hamza and sara on the default plan, mina under the sales manager, tara with a
// monthly target, una paid per unit, nadia with no plan at all (before the default plan starts).
const people = Object.fromEntries(["hamza", "sara", "mina", "tara", "una", "zero"].map((key) => [key, randomUUID()])) as Record<string, string>;
const cityAccountant = randomUUID();
const ownerT = randomUUID();
const sellerT1 = randomUUID();
const sellerT2 = randomUUID();
const branch = randomUUID();
const cityBranch = randomUUID();
const warehouse = randomUUID();
const warehouseT = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@ledger.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const seller = (key: string) => ctx(people[key], tenantA, "salesperson");
const scoped = ctx(cityAccountant, tenantA, "accountant", [cityBranch]);
const taxed = ctx(ownerT, tenantT, "owner");

let admin: AdminSql;
let lamp: string; // sold at 100, costs 50
let lampT: string;
let retailer: string;
let retailerT: string;
let cash: string;
let bank: string;
let cashT: string;
let bankT: string;
let chequeNo = 451000;

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
type Sale = { quantity: string; shares: { userId: string; percent: string }[]; discount?: string; unitPrice?: string; item?: string };
/** A posted invoice straight from an order, written by the owner for the salespeople named. */
async function sell(date: string, sale: Sale, who: TenantContext = as.owner): Promise<string> {
  const plain = who.tenantId === tenantA;
  const line = { itemId: sale.item ?? (plain ? lamp : lampT), quantity: sale.quantity, unitId: "", unitPrice: sale.unitPrice ?? "", discountPercent: sale.discount ?? "", description: "" };
  const order = await saveSalesDraft(who, null, { kind: "order", date, customerId: plain ? retailer : retailerT, warehouseId: plain ? warehouse : warehouseT, lines: [line], shares: sale.shares });
  await submitSalesDocument(who, order.id, undefined, { reason: "Test order" }).catch(async () => submitSalesDocument(who, order.id));
  const { id } = await startInvoice(who, order.id);
  const draft = (await getSalesDocument(who, id))!;
  await saveInvoiceDraft(who, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(who, id);
  return id;
}
const by = (key: string, percent = "100") => ({ userId: people[key], percent });
/** Cash against invoices, posted. */
async function cashIn(date: string, pays: [string, string][], who: TenantContext = as.accountant): Promise<string> {
  const amount = pays.reduce((sum, [, paid]) => sum.plus(paid), new Decimal(0)).toFixed(2);
  const draft = await saveReceiptDraft(who, null, { date, customerId: who.tenantId === tenantA ? retailer : retailerT, method: "cash", accountId: who.tenantId === tenantA ? cash : cashT, amount, allocations: pays.map(([id, paid]) => ({ kind: "invoice", id, amount: paid })) });
  await postReceipt(who, draft.id);
  return draft.id;
}
/** A cheque against an invoice, received and no more. */
async function chequeIn(date: string, invoiceId: string, amount: string, who: TenantContext = as.accountant): Promise<string> {
  chequeNo += 1;
  const draft = await saveReceiptDraft(who, null, { date, customerId: who.tenantId === tenantA ? retailer : retailerT, method: "cheque", amount, chequeNumber: String(chequeNo), chequeBank: "Meezan Bank", chequeDate: date, allocations: [{ kind: "invoice", id: invoiceId, amount }] });
  await postReceipt(who, draft.id);
  return draft.id;
}
async function clear(receiptId: string, date: string, who: TenantContext = as.accountant): Promise<void> {
  await depositCheque(who, receiptId, { accountId: who.tenantId === tenantA ? bank : bankT, date });
  await clearCheque(who, receiptId, { date, bankCharges: "" });
}
/** A posted credit note for so many of the invoice's (only) line. */
async function giveBack(date: string, invoiceId: string, quantity: string, who: TenantContext = as.accountant): Promise<string> {
  const { id } = await startCreditNote(who, invoiceId);
  const [line] = await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${invoiceId}`;
  await saveCreditNoteDraft(who, id, { date, lines: [{ sourceLineId: line.id, quantity, damaged: "" }] });
  await postCreditNote(who, id);
  return id;
}
const name = (userId: string) => Object.entries({ ...people, ...userIds, t1: sellerT1, t2: sellerT2 }).find(([, id]) => id === userId)?.[0] ?? "?";
const n = (value: string) => new Decimal(value).toFixed(4).replace(/\.?0+$/, "");
/** Where each accrual of an invoice stands: who, on what, earned / released / paid. */
async function standing(invoiceId: string): Promise<string[]> {
  const rows = await admin<{ user_id: string; kind: string; base: string; earned: string; released: string; paid: string; approved: boolean }[]>`
    select a.user_id, a.kind, a.base::text, a.earned::text, a.released::text, a.paid::text, a.approved_at is not null as approved
    from public.commission_accruals a where a.invoice_id = ${invoiceId} order by a.kind, a.level, a.share_percent desc`;
  return rows.map((r) => `${name(r.user_id)} ${r.kind} on ${n(r.base)}: ${n(r.earned)} / ${n(r.released)} / ${n(r.paid)}${r.approved ? " approved" : ""}`);
}
/** Every movement of an invoice's accruals, in the order written. */
async function movements(invoiceId: string): Promise<string[]> {
  const rows = await admin<{ type: string; amount: string }[]>`
    select m.type, m.amount::text from public.commission_movements m join public.commission_accruals a on a.id = m.accrual_id
    where a.invoice_id = ${invoiceId} order by m.seq`;
  return rows.map((r) => `${r.type} ${n(r.amount)}`);
}
const journalOf = async (sourceType: string, sourceId: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.source_type = ${sourceType} and j.source_id = ${sourceId} order by l.line_no`
  ).map((row) => row.line);
const accrualIds = async (invoiceId: string) => (await admin<{ id: string }[]>`select id from public.commission_accruals where invoice_id = ${invoiceId} order by kind, level`).map((row) => row.id);
const pay = (who: TenantContext, key: string, date: string) => payCommission(who, people[key], { date, accountId: cash }).then((paid) => `${paid.number}: ${n(paid.gross.toFixed(4))} - ${n(paid.recovered.toFixed(4))} = ${n(paid.amount.toFixed(4))}`);
/** The books agree with the accruals: the expense is what is earned, and what is owed is what is earned and not yet paid. */
async function booksAgree(tenantId = tenantA): Promise<void> {
  const [sums] = await admin`select coalesce(sum(earned), 0)::text as earned, coalesce(sum(paid), 0)::text as paid from public.commission_accruals where tenant_id = ${tenantId}`;
  const balance = async (control: string) =>
    (
      await admin`select coalesce(sum(l.debit - l.credit), 0)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantId} and a.control_type = ${control}`
    )[0].v as string;
  expect(n(await balance("commission_expense")), "Sales commission").toBe(n(sums.earned));
  expect(n(new Decimal(await balance("commission_payable")).neg().toFixed(4)), "Commission payable").toBe(n(new Decimal(sums.earned).minus(sums.paid).toFixed(4)));
  // Every accrual is the sum of its movements (the database refuses anything else; asked again here).
  const off = await admin`
    select a.id from public.commission_accruals a
    cross join lateral (
      select coalesce(sum(m.amount) filter (where m.type in ('accrued', 'entitlement_adjusted')), 0) as earned,
             coalesce(sum(case m.type when 'released' then m.amount when 'release_reversed' then -m.amount end), 0) as released,
             coalesce(sum(case m.type when 'paid' then m.amount when 'recovery_recorded' then -m.amount end), 0) as paid
      from public.commission_movements m where m.accrual_id = a.id) s
    where a.tenant_id = ${tenantId} and (a.earned <> s.earned or a.released <> s.released or a.paid <> s.paid)`;
  expect(off.length, "accruals that are not the sum of their movements").toBe(0);
}

describe.skipIf(!hasDb)("commission earned, released, taken back and paid", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantT}, ${PREFIX + " T"}, ${ownerT})`;
    const branchT = randomUUID();
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner}), (${branchT}, ${tenantT}, 'Main', ${ownerT})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenantA}, ${branch}, 'Main store', ${userIds.owner}), (${warehouseT}, ${tenantT}, ${branchT}, 'Main store', ${ownerT})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      ...Object.entries(people).map(([key, id]) => ({ tenant_id: tenantA, user_id: id, email: `${key}@ledger.test`, role: "salesperson", branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: cityAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantT, user_id: ownerT, email: taxed.email, role: "owner", branch_ids: null, created_by: ownerT },
      { tenant_id: tenantT, user_id: sellerT1, email: "t1@ledger.test", role: "salesperson", branch_ids: null, created_by: ownerT },
      { tenant_id: tenantT, user_id: sellerT2, email: "t2@ledger.test", role: "salesperson", branch_ids: null, created_by: ownerT },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantT}, true, '1234567890123', now(), 'trading', ${ownerT})`;
    await admin`select app.seed_tax_defaults(${tenantT}, ${ownerT})`;
    for (const owner of [as.owner, taxed]) {
      await setBaseCurrency(owner, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(owner, "trading");
      await openFiscalYear(owner, { month: "7", year: "2026" });
    }
    const account = async (tenantId: string, code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and code = ${code}`)[0].id;
    cash = await account(tenantA, "1111");
    cashT = await account(tenantT, "1111");
    bank = (await addAccount(as.owner, { parentId: await account(tenantA, "1120"), name: "HBL current account", code: "", kind: "account" })).id;
    bankT = (await addAccount(taxed, { parentId: await account(tenantT, "1120"), name: "HBL current account", code: "", kind: "account" })).id;
    lamp = (await createItem(as.owner, { code: "LT-1", name: "Lamp", unit: (await addUnit(as.owner, { code: "pc", name: "Piece" })).id, defaultPrice: "100" })).id;
    lampT = (await createItem(taxed, { code: "LT-1", name: "Lamp", unit: (await addUnit(taxed, { code: "pc", name: "Piece" })).id, defaultPrice: "100" })).id;
    retailer = (await createParty(as.owner, "customer", { name: "Corner Shop", code: "C-001" })).id;
    retailerT = (await createParty(taxed, "customer", { name: "Registered Dealer", code: "C-001", registrationType: "registered", ntn: "1234567", strn: "3277876123456", atlStatus: "active" })).id;
    await seedStock(admin, { tenantId: tenantA, warehouseId: warehouse, userId: userIds.owner, itemId: lamp, quantity: "100000", value: "5000000" });
    await seedStock(admin, { tenantId: tenantT, warehouseId: warehouseT, userId: ownerT, itemId: lampT, quantity: "100000", value: "5000000" });

    // The plans: 2% for everyone from 1 September; the sales manager earns 1% on what their
    // team sells; tara's 2% doubles from the sale that takes her to 15,000 in a month; una is
    // paid 10 a piece. Mina reports to the sales manager.
    const plan = (over: Record<string, unknown>) => ({ name: "Standard plan", kind: "flat", rate: "2", from: "2026-09-01", to: "", ...over });
    await savePlan(as.owner, null, plan({}));
    await savePlan(as.owner, null, plan({ name: "Area manager", userId: userIds.sales_manager, rate: "2", teamRate: "1" }));
    await savePlan(as.owner, null, plan({ name: "Tara", userId: people.tara, target: "15000", multiplier: "2" }));
    await savePlan(as.owner, null, plan({ name: "Una", userId: people.una, kind: "per_unit", rate: "10" }));
    await savePlan(as.owner, null, plan({ name: "Zero", userId: people.zero, rate: "0" }));
    await setManager(as.owner, people.mina, userIds.sales_manager);
    await savePlan(taxed, null, plan({}));
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantT]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("accrues when an invoice is posted, and releases as the customer pays: cash at once, a cheque when it clears", async () => {
    // COM-016: 100 lamps at 100. Hamza's 2% of 10,000 is earned; nothing is released or paid.
    const invoice = await sell("2026-10-01", { quantity: "100", shares: [by("hamza")] });
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 0 / 0"]);
    // COM-065: the accrual's journal, dated the invoice's day.
    expect(await journalOf("commission_accrual", invoice)).toEqual(["5220 Sales commission: 200 / 0", "2320 Commission payable: 0 / 200"]);
    const [journal] = await admin`select journal_date::text, document_number from public.journals where source_type = 'commission_accrual' and source_id = ${invoice}`;
    expect(journal).toEqual({ journal_date: "2026-10-01", document_number: null });
    // COM-017: half is paid in cash; half is released.
    await cashIn("2026-10-02", [[invoice, "5000"]]);
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 100 / 0"]);
    expect(await movements(invoice)).toEqual(["accrued 200", "released 100"]);
    // COM-019: a cheque for the rest, received and then deposited, releases nothing.
    const cheque = await chequeIn("2026-10-03", invoice, "5000");
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 100 / 0"]);
    await depositCheque(as.accountant, cheque, { accountId: bank, date: "2026-10-04" });
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 100 / 0"]);
    // COM-018: it clears; all of it is released.
    await clearCheque(as.accountant, cheque, { date: "2026-10-05", bankCharges: "" });
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 200 / 0"]);
    // COM-020: it bounces after all; its half goes back.
    await bounceCheque(as.accountant, cheque, { date: "2026-10-06", reason: "Insufficient funds" });
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 100 / 0"]);
    expect(await movements(invoice)).toEqual(["accrued 200", "released 100", "released 100", "release_reversed 100"]);
    const dated = await admin`select m.type, m.movement_date::text as on, m.source_type from public.commission_movements m join public.commission_accruals a on a.id = m.accrual_id where a.invoice_id = ${invoice} order by m.seq`;
    expect(dated.map((m) => `${m.type} ${m.on} ${m.source_type}`)).toEqual(["accrued 2026-10-01 sales_invoice", "released 2026-10-02 receipt", "released 2026-10-05 receipt", "release_reversed 2026-10-06 receipt"]);
    // COL-100: the customer pays again in cash; released once more, nothing paid yet.
    await cashIn("2026-10-07", [[invoice, "5000"]]);
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 200 / 0"]);
    // A cheque that bounces before it clears had released nothing: nothing to take back.
    const second = await sell("2026-10-07", { quantity: "100", shares: [by("hamza")] });
    const early = await chequeIn("2026-10-07", second, "10000");
    await bounceCheque(as.accountant, early, { date: "2026-10-08", reason: "Stopped" });
    expect(await movements(second)).toEqual(["accrued 200"]);
    // A cash receipt entered by mistake and cancelled takes its release back.
    const mistake = await cashIn("2026-10-08", [[second, "2500"]]);
    expect(await standing(second)).toEqual(["hamza own on 10000: 200 / 50 / 0"]);
    await cancelReceipt(as.accountant, mistake, { date: "2026-10-08", reason: "Wrong customer" });
    expect(await movements(second)).toEqual(["accrued 200", "released 50", "release_reversed 50"]);
    await booksAgree();
  });

  it("splits a line between salespeople, pays managers on their team's sales, and keeps what a plan gave", async () => {
    // COM-032: 60/40.
    const split = await sell("2026-10-09", { quantity: "100", shares: [by("hamza", "60"), by("sara", "40")] });
    expect(await standing(split)).toEqual(["hamza own on 6000: 120 / 0 / 0", "sara own on 4000: 80 / 0 / 0"]);
    // COM-038: a 10% discount: the base is what the line comes to after it.
    expect(await standing(await sell("2026-10-09", { quantity: "100", discount: "10", shares: [by("sara")] }))).toEqual(["sara own on 9000: 180 / 0 / 0"]);
    // COM-031: nobody's sale: nothing accrues and nothing is posted.
    const nobody = await sell("2026-10-09", { quantity: "100", shares: [] });
    expect(await standing(nobody)).toEqual([]);
    expect(await journalOf("commission_accrual", nobody)).toEqual([]);
    // COM-067: before any plan starts, nothing accrues.
    expect(await standing(await sell("2026-08-20", { quantity: "100", shares: [by("sara")] }))).toEqual([]);
    // COM-069: a plan at 0%: an accrual of nothing, and no journal.
    const zero = await sell("2026-10-09", { quantity: "100", shares: [by("zero")] });
    expect(await standing(zero)).toEqual(["zero own on 10000: 0 / 0 / 0"]);
    expect(await journalOf("commission_accrual", zero)).toEqual([]);
    // COM-013: per unit, 10 a piece.
    expect(await standing(await sell("2026-10-09", { quantity: "7", shares: [by("una")] }))).toEqual(["una own on 700: 70 / 0 / 0"]);

    // Mina's sale: her 2%, and 1% of it for the sales manager above her. One journal for both.
    const team = await sell("2026-10-10", { quantity: "100", shares: [by("mina")] });
    expect(await standing(team)).toEqual(["mina own on 10000: 200 / 0 / 0", "sales_manager team on 10000: 100 / 0 / 0"]);
    expect(await journalOf("commission_accrual", team)).toEqual(["5220 Sales commission: 300 / 0", "2320 Commission payable: 0 / 300"]);
    // Both are released together, and both come down together when half the goods come back.
    await cashIn("2026-10-11", [[team, "10000"]]);
    expect(await standing(team)).toEqual(["mina own on 10000: 200 / 200 / 0", "sales_manager team on 10000: 100 / 100 / 0"]);
    const back = await giveBack("2026-10-12", team, "50");
    expect(await standing(team)).toEqual(["mina own on 10000: 100 / 100 / 0", "sales_manager team on 10000: 50 / 50 / 0"]);
    expect(await journalOf("commission_return", back)).toEqual(["2320 Commission payable: 150 / 0", "5220 Sales commission: 0 / 150"]);

    // COM-029: the plan's rate is changed afterwards; what was earned stays, and the next sale takes the new rate.
    const [standard] = await admin<{ id: string }[]>`select id from public.commission_plans where tenant_id = ${tenantA} and name = 'Standard plan'`;
    await savePlan(as.owner, standard.id, { name: "Standard plan", kind: "flat", rate: "9", from: "2026-09-01", to: "" });
    expect(await standing(split)).toEqual(["hamza own on 6000: 120 / 0 / 0", "sara own on 4000: 80 / 0 / 0"]);
    expect(await standing(await sell("2026-10-12", { quantity: "10", shares: [by("sara")] }))).toEqual(["sara own on 1000: 90 / 0 / 0"]);
    await savePlan(as.owner, standard.id, { name: "Standard plan", kind: "flat", rate: "2", from: "2026-09-01", to: "" });
    await booksAgree();
  });

  it("takes commission back when goods are returned, and what is released follows", async () => {
    // COM-035: 50 of 100 come back before anything is paid: half is no longer earned.
    const unpaid = await sell("2026-10-13", { quantity: "100", shares: [by("sara")] });
    const first = await giveBack("2026-10-14", unpaid, "50");
    expect(await standing(unpaid)).toEqual(["sara own on 10000: 100 / 0 / 0"]);
    expect(await movements(unpaid)).toEqual(["accrued 200", "entitlement_adjusted -100"]);
    expect(await journalOf("commission_return", first)).toEqual(["2320 Commission payable: 100 / 0", "5220 Sales commission: 0 / 100"]);
    // The rest of it comes back: nothing is earned.
    await giveBack("2026-10-15", unpaid, "50");
    expect(await standing(unpaid)).toEqual(["sara own on 10000: 0 / 0 / 0"]);
    // COM-036: paid in full, then half comes back: what is left is earned and released.
    const paid = await sell("2026-10-13", { quantity: "100", shares: [by("sara")] });
    await cashIn("2026-10-14", [[paid, "10000"]]);
    await giveBack("2026-10-15", paid, "50");
    expect(await standing(paid)).toEqual(["sara own on 10000: 100 / 100 / 0"]);
    expect((await movements(paid)).slice(-2)).toEqual(["entitlement_adjusted -100", "release_reversed 100"]);
    // COM-073: per unit: 4 of 10 come back.
    const units = await sell("2026-10-13", { quantity: "10", shares: [by("una")] });
    await giveBack("2026-10-14", units, "4");
    expect(await standing(units)).toEqual(["una own on 1000: 60 / 0 / 0"]);
    // Part paid, then part returned: 4,000 of 10,000 paid; 50 come back; 4,000 of the 5,000 left is collected.
    const part = await sell("2026-10-13", { quantity: "100", shares: [by("sara")] });
    await cashIn("2026-10-14", [[part, "4000"]]);
    expect(await standing(part)).toEqual(["sara own on 10000: 200 / 80 / 0"]);
    await giveBack("2026-10-15", part, "50");
    expect(await standing(part)).toEqual(["sara own on 10000: 100 / 80 / 0"]);
    await booksAgree();
  });

  it("releases to the fourth decimal however the money comes in", async () => {
    // COM-077: one lamp at 33.33: 0.6666. Paid 11.11 and then 22.22.
    const small = await sell("2026-10-16", { quantity: "1", unitPrice: "33.33", shares: [by("sara")] });
    expect(await standing(small)).toEqual(["sara own on 33.33: 0.6666 / 0 / 0"]);
    await cashIn("2026-10-16", [[small, "11.11"]]);
    await cashIn("2026-10-16", [[small, "22.22"]]);
    expect(await standing(small)).toEqual(["sara own on 33.33: 0.6666 / 0.6666 / 0"]);
    expect(await movements(small)).toEqual(["accrued 0.6666", "released 0.2222", "released 0.4444"]);
    // COM-078: three payments of 3,333.33 and one of 0.01: released 200 exactly.
    const thirds = await sell("2026-10-16", { quantity: "100", shares: [by("sara")] });
    for (const amount of ["3333.33", "3333.33", "3333.33", "0.01"]) await cashIn("2026-10-16", [[thirds, amount]]);
    expect(await standing(thirds)).toEqual(["sara own on 10000: 200 / 200 / 0"]);
    expect(await movements(thirds)).toEqual(["accrued 200", "released 66.6666", "released 66.6666", "released 66.6666", "released 0.0002"]);
    // COM-075: one receipt of 15,000 over two invoices: 10,000 of 10,000 and 5,000 of 20,000.
    const a = await sell("2026-10-16", { quantity: "100", shares: [by("hamza")] });
    const b = await sell("2026-10-16", { quantity: "200", shares: [by("sara")] });
    await cashIn("2026-10-17", [
      [a, "10000"],
      [b, "5000"],
    ]);
    expect([...(await standing(a)), ...(await standing(b))]).toEqual(["hamza own on 10000: 200 / 200 / 0", "sara own on 20000: 400 / 100 / 0"]);
    await booksAgree();
  });

  it("is approved by the owner or an accountant, paid, and taken back out of later commission when the sale is undone", async () => {
    // COM-021. A cheque clears; the commission is approved and paid.
    const invoice = await sell("2026-10-18", { quantity: "100", shares: [by("tara")] });
    const cheque = await chequeIn("2026-10-18", invoice, "10000");
    const [accrual] = await accrualIds(invoice);
    // COM-023: nothing released yet, nothing to approve.
    await expect(approveCommission(as.owner, [accrual])).rejects.toThrow("There is no released unpaid commission to approve.");
    await clear(cheque, "2026-10-19");
    // COM-047 and the founder's decision: the owner and an accountant approve; the sales manager and the rest do not.
    for (const role of ["sales_manager", "salesperson", "auditor", "recovery_officer"] as const) await expect(approveCommission(as[role], [accrual]), role).rejects.toThrow("Your role does not permit this action.");
    expect(await codeOf(as.sales_manager, sql`select app.approve_commission(array[${accrual}::uuid])`)).toBe("42501");
    await expect(approveCommission(as.accountant, [])).rejects.toThrow("Choose the commission to approve.");
    // COM-099: another company's commission is not there.
    await expect(approveCommission(taxed, [accrual])).rejects.toThrow("Commission not found.");
    await expect(pay(as.owner, "tara", "2026-10-19")).rejects.toThrow("There is no approved commission to pay this person. Approve it first.");
    // COM-022.
    expect(await approveCommission(as.accountant, [accrual])).toEqual({ approved: 1 });
    expect(await standing(invoice)).toEqual(["tara own on 10000: 200 / 200 / 0 approved"]);
    // Paying: the owner or an accountant who works across the company, from a cash or bank account, not in the future.
    for (const role of ["sales_manager", "salesperson", "auditor"] as const) await expect(pay(as[role], "tara", "2026-10-20"), role).rejects.toThrow("Your role does not permit this action.");
    await expect(pay(scoped, "tara", "2026-10-20")).rejects.toThrow("Commission is paid by someone who works across the whole company");
    await expect(pay(as.owner, "tara", "2027-01-01")).rejects.toThrow("That date has not come yet.");
    const [sales] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '4100'`;
    await expect(payCommission(as.owner, people.tara, { date: "2026-10-20", accountId: sales.id })).rejects.toThrow("Choose a cash or bank account that is in use.");
    expect(await pay(as.owner, "tara", "2026-10-20")).toBe("CP-2627-00001: 200 - 0 = 200");
    expect(await standing(invoice)).toEqual(["tara own on 10000: 200 / 200 / 200"]);
    const [payment] = await admin<{ id: string }[]>`select id from public.commission_payments where tenant_id = ${tenantA} and number = 'CP-2627-00001'`;
    // COM-066: paying takes it off what is owed.
    expect(await journalOf("commission_payment", payment.id)).toEqual(["2320 Commission payable: 200 / 0", "1111 Cash in hand: 0 / 200"]);
    // COM-024: all of it is paid; there is nothing more to approve.
    await expect(approveCommission(as.owner, [accrual])).rejects.toThrow("There is no released unpaid commission to approve.");

    // The cheque bounces after all. The release goes back; what was paid is now owed back.
    await bounceCheque(as.accountant, cheque, { date: "2026-10-21", reason: "Insufficient funds" });
    expect(await standing(invoice)).toEqual(["tara own on 10000: 200 / 0 / 200"]);
    expect((await getEarned(as.owner)).people.find((p) => p.userId === people.tara)!.totals.owedBack.toFixed(2)).toBe("200.00");
    // Her next sale is paid for and approved: 15,000 this month reaches her target, so 2% doubles: 400 on 10,000.
    const next = await sell("2026-10-22", { quantity: "100", shares: [by("tara")] });
    expect(await standing(next)).toEqual(["tara own on 10000: 400 / 0 / 0"]);
    await cashIn("2026-10-22", [[next, "10000"]]);
    await approveCommission(as.owner, await accrualIds(next));
    // The 200 she owes back comes out of it: 200 leaves the cash.
    expect(await pay(as.accountant, "tara", "2026-10-23")).toBe("CP-2627-00002: 400 - 200 = 200");
    expect(await standing(invoice)).toEqual(["tara own on 10000: 200 / 0 / 0"]);
    expect(await standing(next)).toEqual(["tara own on 10000: 400 / 400 / 400"]);
    // COM-030: the whole life of the first accrual, in order.
    expect(await movements(invoice)).toEqual(["accrued 200", "released 200", "paid 200", "release_reversed 200", "recovery_recorded 200"]);
    // The customer pays the first invoice after all: released again, to be approved and paid like any other.
    await cashIn("2026-10-24", [[invoice, "10000"]]);
    expect(await standing(invoice)).toEqual(["tara own on 10000: 200 / 200 / 0"]);
    const payments = await listPayments(as.auditor);
    expect(payments.map((p) => `${p.number} ${p.name} ${p.date} ${n(p.gross.toFixed(4))} ${n(p.recovered.toFixed(4))} ${n(p.amount.toFixed(4))}`)).toEqual([
      "CP-2627-00002 tara@ledger.test 2026-10-23 400 200 200",
      "CP-2627-00001 tara@ledger.test 2026-10-20 200 0 200",
    ]);
    await booksAgree();
  });

  it("carries forward what is owed back when the next commission is not enough, and clears an approval that a change has overtaken", async () => {
    // COM-037. Una's 100 pieces: 1,000 earned, paid for, approved and paid. Then 50 come back: 500 is owed back.
    const big = await sell("2026-10-25", { quantity: "100", shares: [by("una")] });
    await cashIn("2026-10-25", [[big, "10000"]]);
    await approveCommission(as.owner, await accrualIds(big));
    expect(await pay(as.owner, "una", "2026-10-25")).toBe("CP-2627-00003: 1000 - 0 = 1000");
    const back = await giveBack("2026-10-26", big, "50");
    expect(await standing(big)).toEqual(["una own on 10000: 500 / 500 / 1000"]);
    expect(await journalOf("commission_return", back)).toEqual(["2320 Commission payable: 500 / 0", "5220 Sales commission: 0 / 500"]);
    // Her next sale earns 300. All of it goes to what she owes; no money leaves, and 200 is carried forward.
    const small = await sell("2026-10-27", { quantity: "30", shares: [by("una")] });
    await cashIn("2026-10-27", [[small, "3000"]]);
    await approveCommission(as.accountant, await accrualIds(small));
    expect(await pay(as.owner, "una", "2026-10-27")).toBe("CP-2627-00004: 300 - 300 = 0");
    expect(await standing(big)).toEqual(["una own on 10000: 500 / 500 / 700"]);
    const [none] = await admin`select journal_id, amount::text from public.commission_payments where tenant_id = ${tenantA} and number = 'CP-2627-00004'`;
    expect(none).toEqual({ journal_id: null, amount: "0.0000" });
    // The one after: 400 earned; the last 200 comes out and 200 is paid.
    const later = await sell("2026-10-28", { quantity: "40", shares: [by("una")] });
    await cashIn("2026-10-28", [[later, "4000"]]);
    await approveCommission(as.owner, await accrualIds(later));
    expect(await pay(as.owner, "una", "2026-10-28")).toBe("CP-2627-00005: 400 - 200 = 200");
    expect(await standing(big)).toEqual(["una own on 10000: 500 / 500 / 500"]);
    expect((await getEarned(as.owner)).people.find((p) => p.userId === people.una)!.totals.owedBack.toFixed(2)).toBe("0.00");

    // COM-091: approved, and then the cheque behind it bounces before it is paid: the approval is gone with the release.
    const invoice = await sell("2026-10-28", { quantity: "100", shares: [by("hamza")] });
    const cheque = await chequeIn("2026-10-28", invoice, "10000");
    await clear(cheque, "2026-10-28");
    await approveCommission(as.owner, await accrualIds(invoice));
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 200 / 0 approved"]);
    await bounceCheque(as.accountant, cheque, { date: "2026-10-29", reason: "Insufficient funds" });
    expect(await standing(invoice)).toEqual(["hamza own on 10000: 200 / 0 / 0"]);
    // A part payment after approval clears it too: the figure approved is no longer the figure.
    const other = await sell("2026-10-28", { quantity: "100", shares: [by("hamza")] });
    await cashIn("2026-10-28", [[other, "5000"]]);
    await approveCommission(as.owner, await accrualIds(other));
    await cashIn("2026-10-29", [[other, "5000"]]);
    expect(await standing(other)).toEqual(["hamza own on 10000: 200 / 200 / 0"]);
    await booksAgree();
  });

  it("measures a month's target on what was sold in the month, less what came back in it", async () => {
    // Tara has sold 20,000 in October. Nothing in November yet (the dates here are 1 to 14 November).
    const first = await sell("2026-11-01", { quantity: "100", shares: [by("tara")] });
    expect(await standing(first)).toEqual(["tara own on 10000: 200 / 0 / 0"]);
    // The second 10,000 takes her to 20,000, past the target of 15,000: doubled.
    const second = await sell("2026-11-02", { quantity: "100", shares: [by("tara")] });
    expect(await standing(second)).toEqual(["tara own on 10000: 400 / 0 / 0"]);
    // All of the first sale comes back in November: her month is 10,000 again, and its commission is gone.
    await giveBack("2026-11-03", first, "100");
    expect(await standing(first)).toEqual(["tara own on 10000: 0 / 0 / 0"]);
    // So the next 2,000 leaves her at 12,000, short of the target: 2%, not doubled.
    const third = await sell("2026-11-04", { quantity: "20", shares: [by("tara")] });
    expect(await standing(third)).toEqual(["tara own on 2000: 40 / 0 / 0"]);
    // What was worked out when each was posted stays: the second sale keeps its 400.
    expect(await standing(second)).toEqual(["tara own on 10000: 400 / 0 / 0"]);
    // A return of an October sale in November comes off November, not October.
    const [october] = await admin<{ id: string }[]>`select d.id from public.sales_documents d join public.commission_accruals a on a.invoice_id = d.id where a.user_id = ${people.tara} and a.invoice_date = '2026-10-22'`;
    await giveBack("2026-11-05", october.id, "100");
    const month = async (date: string) => (await admin`select app.commission_month_sales(${tenantA}, ${people.tara}, ${date}::date)::text as v`)[0].v as string;
    expect(n(await month("2026-10-15"))).toBe("20000");
    expect(n(await month("2026-11-15"))).toBe("2000");
    await booksAgree();
  });

  it("follows the whole of a taxed, shared sale from invoice to recovery", async () => {
    // COM-039 and COM-100. 100 lamps at 100 plus 18% tax: 11,800. The base is the 10,000 before tax, shared 60/40.
    const shares = [
      { userId: sellerT1, percent: "60" },
      { userId: sellerT2, percent: "40" },
    ];
    const invoice = await sell("2026-10-05", { quantity: "100", shares }, taxed);
    expect((await getSalesDocument(taxed, invoice))!.totals.total.toFixed(2)).toBe("11800.00");
    expect(await standing(invoice)).toEqual(["t1 own on 6000: 120 / 0 / 0", "t2 own on 4000: 80 / 0 / 0"]);
    // Half of the 11,800 in cash: half of each is released.
    await cashIn("2026-10-06", [[invoice, "5900"]], taxed);
    expect(await standing(invoice)).toEqual(["t1 own on 6000: 120 / 60 / 0", "t2 own on 4000: 80 / 40 / 0"]);
    // The other half by cheque, cleared.
    const cheque = await chequeIn("2026-10-07", invoice, "5900", taxed);
    await clear(cheque, "2026-10-08", taxed);
    expect(await standing(invoice)).toEqual(["t1 own on 6000: 120 / 120 / 0", "t2 own on 4000: 80 / 80 / 0"]);
    // Approved and paid, each their own.
    await approveCommission(taxed, await accrualIds(invoice));
    const paid = async (userId: string, date: string) => payCommission(taxed, userId, { date, accountId: cashT }).then((p) => `${n(p.gross.toFixed(4))} - ${n(p.recovered.toFixed(4))} = ${n(p.amount.toFixed(4))}`);
    expect([await paid(sellerT1, "2026-10-09"), await paid(sellerT2, "2026-10-09")]).toEqual(["120 - 0 = 120", "80 - 0 = 80"]);
    // The cheque bounces: half of each release goes back, and 100 is owed back between them.
    await bounceCheque(taxed, cheque, { date: "2026-10-10", reason: "Insufficient funds" });
    expect(await standing(invoice)).toEqual(["t1 own on 6000: 120 / 60 / 120", "t2 own on 4000: 80 / 40 / 80"]);
    expect((await getEarned(taxed)).people.map((p) => `${p.name} ${p.totals.owedBack.toFixed(2)}`)).toEqual(["t1@ledger.test 60.00", "t2@ledger.test 40.00"]);
    // Their next sale, paid for and approved, pays for it: 120 less 60, and 80 less 40.
    const next = await sell("2026-10-11", { quantity: "100", shares }, taxed);
    await cashIn("2026-10-11", [[next, "11800"]], taxed);
    await approveCommission(taxed, await accrualIds(next));
    expect([await paid(sellerT1, "2026-10-12"), await paid(sellerT2, "2026-10-12")]).toEqual(["120 - 60 = 60", "80 - 40 = 40"]);
    expect(await standing(invoice)).toEqual(["t1 own on 6000: 120 / 60 / 60", "t2 own on 4000: 80 / 40 / 40"]);
    await booksAgree(tenantT);
  });

  it("is read by those it concerns and written by nobody but the database's own functions", async () => {
    const [mine] = await admin<{ id: string; invoice_id: string }[]>`select id, invoice_id from public.commission_accruals where tenant_id = ${tenantA} and user_id = ${people.hamza} order by invoice_date limit 1`;
    // The owner, an accountant and the auditor read everyone's; a salesperson and a manager their own; the rest nothing.
    const count = (who: TenantContext) => withTenant(who.userId, tenantA, (tx) => tx.execute(sql`select 1 from commission_accruals`)).then((rows) => rows.length);
    const all = await count(as.owner);
    expect(all).toBeGreaterThan(20);
    expect([await count(as.accountant), await count(as.auditor)]).toEqual([all, all]);
    const [own] = await admin`select count(*)::int as n from public.commission_accruals where tenant_id = ${tenantA} and user_id = ${people.hamza}`;
    expect(await count(seller("hamza"))).toBe(own.n);
    expect(await count(as.sales_manager)).toBe(1);
    expect([await count(as.warehouse_manager), await count(as.recovery_officer), await count(scoped)]).toEqual([0, 0, 0]);
    expect((await withTenant(ownerT, tenantT, (tx) => tx.execute(sql`select 1 from commission_accruals where tenant_id = ${tenantA}::uuid`))).length).toBe(0);
    const earned = await getEarned(seller("hamza"));
    expect(earned.people.map((p) => p.name)).toEqual(["hamza@ledger.test"]);
    await expect(getEarned(as.warehouse_manager)).rejects.toThrow("Your role does not include commission.");
    expect((await getInvoiceCommission(as.auditor, mine.invoice_id))!.accruals.map((a) => `${a.invoiceNumber} ${a.itemCode} ${a.kind}`)).toEqual(["SI-2627-00001 LT-1 own"]);
    expect((await listMovements(seller("hamza"), [mine.id])).map((m) => m.type)).toEqual(["accrued", "released", "released", "release_reversed", "released"]);
    expect(await listMovements(seller("sara"), [mine.id])).toEqual([]);

    // Nothing here is the app's role's to write, whoever is signed in.
    for (const statement of [
      sql`update commission_accruals set released = earned, paid = 0 where id = ${mine.id}::uuid`,
      sql`delete from commission_accruals where id = ${mine.id}::uuid`,
      sql`insert into commission_movements (tenant_id, accrual_id, type, amount, movement_date, source_type, source_id, created_by) values (${tenantA}::uuid, ${mine.id}::uuid, 'released', 5, '2026-10-30', 'receipt', gen_random_uuid(), ${userIds.owner}::uuid)`,
      sql`update commission_movements set amount = 1 where accrual_id = ${mine.id}::uuid`,
      sql`delete from commission_movements where accrual_id = ${mine.id}::uuid`,
      sql`delete from commission_payments`,
      sql`insert into commission_payments (tenant_id, number, user_id, payment_date, account_id, gross, amount, created_by) values (${tenantA}::uuid, 'CP-2627-00099', ${people.hamza}::uuid, '2026-10-30', ${cash}::uuid, 5, 5, ${userIds.owner}::uuid)`,
    ]) {
      expect(await codeOf(as.owner, statement)).toBe("42501");
    }
    // Nor are the functions underneath, or a journal or an audit row that looks like theirs.
    for (const statement of [
      sql`select app.refresh_commission(${tenantA}::uuid, ${mine.invoice_id}::uuid, 'receipt', gen_random_uuid(), '2026-10-30')`,
      sql`select app.commission_month_sales(${tenantA}::uuid, ${people.hamza}::uuid, '2026-10-30')`,
      sql`select app.commission_collected(${tenantA}::uuid, ${mine.invoice_id}::uuid)`,
      sql`select * from app.commission_on_line(${tenantA}::uuid, ${people.hamza}::uuid, '2026-10-30', ${lamp}::uuid, ${retailer}::uuid, 1000, 10, 0)`,
      sql`insert into audit_log (tenant_id, actor_user_id, actor_role, action, entity) values (${tenantA}::uuid, ${userIds.owner}::uuid, 'owner', 'commission.pay', 'commission_payment')`,
    ]) {
      expect(await codeOf(as.owner, statement)).toBe("42501");
    }
    // Even the database's owner cannot change a movement: only a whole test company is ever removed.
    await expect(admin`update public.commission_movements set amount = 1 where accrual_id = ${mine.id}`).rejects.toMatchObject({ code: "SE315" });
    // And an accrual that is not the sum of its movements is refused when the transaction ends.
    await expect(admin.begin((tx) => tx`update public.commission_accruals set released = released - 1 where id = ${mine.id}`)).rejects.toMatchObject({ code: "SE316" });
    // A branch accountant finds no commission on another branch's invoice to approve.
    await expect(approveCommission(scoped, [mine.id])).rejects.toThrow("Commission not found.");
    // Approving and paying are written in the audit log.
    const log = await admin`select action, count(*)::int as n from public.audit_log where tenant_id = ${tenantA} and action like 'commission.%' group by action order by action`;
    expect(log.map((row) => row.action)).toEqual(["commission.accrue", "commission.approve", "commission.pay", "commission.return"]);
    await booksAgree();
  });
});
