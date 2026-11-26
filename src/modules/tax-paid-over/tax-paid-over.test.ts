import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { cancelExpense, recordExpense } from "@/modules/cash-bank/commands";
import { getExpense } from "@/modules/cash-bank/queries";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { approveRun, reviewRun, workOutRun } from "@/modules/payroll-runs/commands";
import { saveEmployee, setPay } from "@/modules/payroll/commands";
import { getPurchaseReport } from "@/modules/purchase-reports/queries";
import type { PurchaseFilter } from "@/modules/purchase-reports/rules";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import type { ReportTable } from "@/modules/reports/rules";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import { getWithholdingPosition } from "@/modules/supplier-payments/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { recordTaxChallan } from "./commands";
import { listOtherTaxUnpaid } from "./queries";
import { readTaxChallan } from "./rules";

// Tax paid over, against a real database through the app's own path: one challan that pays tax
// withheld on a bill, tax withheld on an expense and a payroll run's salary tax; the register
// and the books after it; what it refuses; and an expense that stands once its tax is paid.
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-tax-paid-over-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const northAccountant = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@paid.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const toDay = (to: string): PurchaseFilter => ({ from: "2026-10-01", to, branchId: null, supplierId: null });
const show = (table: ReportTable) => table.rows.map((row) => row.cells.map((cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2))).join(" | "));

let admin: AdminSql;
let bank: string;
let repairs: string;
let supplier: string;
let billEntry: string;
let secondBillEntry: string;
let expense: { id: string; number: string };
let expenseIncomeTax: string;
let expenseProvincial: string;
let october: { id: string; number: string; tax: string };
let novemberDraft: string;

async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const journal = async (number: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || l.debit::numeric(20,2)::text || ' / ' || l.credit::numeric(20,2)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantA} and j.document_number = ${number} order by l.line_no`
  ).map((r) => r.line);
const books = async (on: string) =>
  (
    await admin<{ amount: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as amount from public.journal_lines l
      join public.journals j on j.id = l.journal_id join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type in ('wht_income_tax', 'wht_sales_tax', 'wht_provincial_tax') and j.journal_date <= ${on}`
  )[0].amount;
const agreed = async (on: string) => {
  const rows = show(await getPurchaseReport(as.auditor, "withholding-register", toDay(on)));
  expect(rows.at(-1), on).toBe(" | Difference |  |  |  |  |  |  |  | 0.00 |  | ");
  return rows;
};
const challan = (over: Record<string, unknown> = {}) => ({ kind: "income_tax", paidOn: "2026-11-14", accountId: bank, challanNo: "IT-20261114-0007", ...over });

/** Helmets ordered, received and billed in full by the supplier, with income tax withheld: the bill's withholding entry. */
async function billed(invoiceNo: string, date: string): Promise<string> {
  const [{ id: helmet }] = await admin<{ id: string }[]>`select id from public.items where tenant_id = ${tenantA} and code = 'HL-1'`;
  const order = await saveOrderDraft(as.owner, null, { date: "2026-11-02", supplierId: supplier, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "10", unitCost: "1000" }] });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveReceiptDraft(as.owner, null, order.id, { date: "2026-11-03", lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postReceipt(as.owner, note.id);
  const [{ id: receiptLineId }] = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id}`;
  const draft = await saveBillDraft(as.accountant, null, { date, supplierId: supplier, branchId: mainBranch, supplierInvoiceNo: invoiceNo, incomeTaxCode: "income_tax.goods.company", goods: [{ receiptLineId, quantity: "10", unitPrice: "1000" }] });
  await postBill(as.accountant, draft.id);
  return (await admin<{ id: string }[]>`select id from public.withholding_entries where tenant_id = ${tenantA} and bill_id = ${draft.id}`)[0].id;
}

describe("a challan as typed", () => {
  it("takes what was ticked of each kind, and asks for something ticked", () => {
    const typed = { kind: "income_tax", paidOn: "2026-11-14", accountId: "a", challanNo: " IT-1 " };
    expect(readTaxChallan({ ...typed, entryIds: ["b1", "b1"], expenseEntryIds: ["e1"], runIds: ["r1", ""] })).toMatchObject({ ok: true, challan: { challanNo: "IT-1", entryIds: ["b1"], expenseEntryIds: ["e1"], runIds: ["r1"] } });
    expect(readTaxChallan({ ...typed, runIds: ["r1"] })).toMatchObject({ ok: true, challan: { entryIds: [], expenseEntryIds: [], runIds: ["r1"] } });
    expect(readTaxChallan(typed)).toEqual({ ok: false, reason: "Tick the amounts withheld that this challan paid." });
    expect(readTaxChallan({ ...typed, kind: "provincial_sales_tax", runIds: ["r1"] })).toMatchObject({ ok: false, reason: expect.stringContaining("Tax deducted from salaries is income tax") });
    expect(readTaxChallan({ ...typed, challanNo: "", expenseEntryIds: ["e1"] })).toMatchObject({ ok: false, reason: "Enter the number on the challan (the CPR number)." });
  });
});

describe.skipIf(!hasDb)("tax paid over", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const [{ id: banks }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1120'`;
    bank = (await addAccount(as.owner, { parentId: banks, name: "HBL current account", code: "", kind: "account" })).id;
    repairs = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '5270'`)[0].id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1500" });
    supplier = (await createParty(as.owner, "supplier", { name: "Karachi Motors (Pvt) Ltd", supplierType: "company", ntn: "7654321" })).id;
    await setWithholding(as.owner, true);

    // 4 and 6 November: two bills of 10,000, 10% income tax withheld on each (1,000 and 1,000).
    billEntry = await billed("KM-1", "2026-11-04");
    secondBillEntry = await billed("KM-2", "2026-11-06");
    // 12 November: van repairs of 20,000 paid out of the bank: Sindh's 15% withheld whole (3,000), income tax 28% of 23,000 (6,440).
    expense = await recordExpense(as.accountant, { date: "2026-11-12", accountId: bank, supplierId: supplier, reference: "KM-SRV-9", incomeTaxCode: "income_tax.services.other", provincialTaxCode: "provincial_sales_tax.sindh", lines: [{ accountId: repairs, description: "Van repairs", amount: "20000" }] });
    const taxes = await admin<{ id: string; kind: string }[]>`select id, kind from public.expense_withholdings where tenant_id = ${tenantA} and expense_id = ${expense.id}`;
    expenseIncomeTax = taxes.find((row) => row.kind === "income_tax")!.id;
    expenseProvincial = taxes.find((row) => row.kind === "provincial_sales_tax")!.id;
    // October's payroll approved (its journal on the 31st), one person taxed; November's worked out and left a draft.
    const employee = await saveEmployee(as.owner, null, { code: "E-001", name: "Imran Qureshi", province: "sindh", payBasis: "monthly", joinedOn: "2026-07-01" });
    await setPay(as.owner, employee.id, { component: "basic", amount: "200000", effectiveFrom: "2026-07-01" });
    const worked = await workOutRun(as.owner, "2026-10-01");
    if (!("id" in worked)) throw new Error(worked.problems.map((p) => p.reason).join("; "));
    await reviewRun(as.owner, worked.id);
    const { number } = await approveRun(as.accountant, worked.id);
    const [{ tax }] = await admin<{ tax: string }[]>`select tax::numeric(20,2)::text as tax from public.payroll_runs where id = ${worked.id}`;
    october = { id: worked.id, number, tax };
    const next = await workOutRun(as.owner, "2026-11-01");
    if (!("id" in next)) throw new Error(next.problems.map((p) => p.reason).join("; "));
    novemberDraft = next.id;
  }, 300_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("lists what no challan has paid yet, beside the bills' entries: the expense's two taxes and October's salary tax", async () => {
    const other = await listOtherTaxUnpaid(as.auditor);
    expect(other.expenses.map((e) => `${e.date} ${e.kind} ${e.supplierName} ${e.expenseNumber} ${e.amount.toFixed(2)}`)).toEqual([
      `2026-11-12 income_tax Karachi Motors (Pvt) Ltd ${expense.number} 6440.00`,
      `2026-11-12 provincial_sales_tax Karachi Motors (Pvt) Ltd ${expense.number} 3000.00`,
    ]);
    // The draft run is not there: nothing is deducted until a run is approved.
    expect(other.salaries.map((r) => `${r.date} ${r.month} ${r.runNumber} ${r.amount.toFixed(2)}`)).toEqual([`2026-10-31 2026-10-01 ${october.number} ${october.tax}`]);
    expect((await getWithholdingPosition(as.auditor)).unpaid).toHaveLength(2);
    // Someone limited to a branch, and another company, see none of it; a salesperson has no way in.
    expect(await listOtherTaxUnpaid(north)).toEqual({ expenses: [], salaries: [] });
    expect(await listOtherTaxUnpaid(otherOwner)).toEqual({ expenses: [], salaries: [] });
    await expect(listOtherTaxUnpaid(as.salesperson)).rejects.toThrow();
    await agreed("2026-11-30");
  });

  it("refuses what will not do, and records nothing", async () => {
    const before = (await admin<{ n: number }[]>`select count(*)::int as n from public.withholding_challans where tenant_id = ${tenantA}`)[0].n;
    const all = { entryIds: [billEntry], expenseEntryIds: [expenseIncomeTax], runIds: [october.id] };
    for (const who of [as.auditor, as.salesperson]) await expect(recordTaxChallan(who, challan(all)), who.role).rejects.toThrow("Only an owner or an accountant can record a challan.");
    await expect(recordTaxChallan(north, challan(all))).rejects.toThrow("only someone who works in every branch");
    await expect(recordTaxChallan(as.owner, challan({ ...all, paidOn: "2099-01-01" }))).rejects.toThrow("That date has not come yet.");
    await expect(recordTaxChallan(as.owner, challan({ ...all, accountId: repairs }))).rejects.toThrow("The money leaves a cash or bank account that is in use.");
    await expect(recordTaxChallan(as.owner, challan({ ...all, kind: "provincial_sales_tax" }))).rejects.toThrow("Tax deducted from salaries is income tax");
    // The wrong kind of tax for an entry; a day before the tax was withheld or deducted; a run not yet approved; an id of nothing.
    const refused = "A challan pays whole amounts of its own kind of tax";
    await expect(recordTaxChallan(as.owner, challan({ expenseEntryIds: [expenseProvincial] }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ expenseEntryIds: [expenseIncomeTax], paidOn: "2026-11-11" }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ runIds: [october.id], paidOn: "2026-10-30" }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ runIds: [novemberDraft] }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ expenseEntryIds: [randomUUID()] }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ entryIds: [billEntry], expenseEntryIds: [expenseIncomeTax], paidOn: "2026-11-03" }))).rejects.toThrow(refused);
    // Another company cannot pay this company's tax; past the app, the database says the same.
    const lists = sql`${`{${billEntry}}`}::uuid[], ${`{${expenseIncomeTax}}`}::uuid[], ${`{${october.id}}`}::uuid[]`;
    const [{ id: otherBank }] = await admin<{ id: string }[]>`select ${bank}::uuid as id`;
    expect(await codeOf(otherOwner, sql`select app.record_tax_challan('income_tax', '2026-11-14'::date, ${otherBank}::uuid, 'X-1', ${lists})`)).toMatch(/^(SE241|SE001|SE379)$/);
    expect(await codeOf(as.auditor, sql`select app.record_tax_challan('income_tax', '2026-11-14'::date, ${bank}::uuid, 'X-1', ${lists})`)).toBe("42501");
    expect(await codeOf(north, sql`select app.record_tax_challan('income_tax', '2026-11-14'::date, ${bank}::uuid, 'X-1', ${lists})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.record_tax_challan('provincial_sales_tax', '2026-11-14'::date, ${bank}::uuid, 'X-1', '{}'::uuid[], '{}'::uuid[], ${`{${october.id}}`}::uuid[])`)).toBe("SE379");
    expect(await codeOf(as.owner, sql`select app.record_tax_challan('income_tax', '2026-11-14'::date, ${bank}::uuid, 'X-1', '{}'::uuid[], ${`{${expenseIncomeTax},${expenseIncomeTax}}`}::uuid[], '{}'::uuid[])`)).toBe("SE379");
    expect(await codeOf(as.owner, sql`select app.record_tax_challan('income_tax', '2026-11-14'::date, ${bank}::uuid, 'X-1', '{}'::uuid[], '{}'::uuid[], '{}'::uuid[])`)).toBe("SE379");
    expect((await admin<{ n: number }[]>`select count(*)::int as n from public.withholding_challans where tenant_id = ${tenantA}`)[0].n).toBe(before);
  });

  it("one challan pays tax withheld on a bill, on an expense, and a payroll run's salary tax: one number, one journal", async () => {
    const amount = new Decimal("1000").plus("6440").plus(october.tax);
    const before = new Decimal(await books("2026-11-30"));
    const { number } = await recordTaxChallan(as.accountant, challan({ note: "October and early November", entryIds: [billEntry], expenseEntryIds: [expenseIncomeTax], runIds: [october.id] }));
    expect(number).toMatch(/^WC-2627-\d{5}$/);
    const bankCode = (await admin<{ code: string }[]>`select code from public.accounts where id = ${bank}`)[0].code;
    expect(await journal(number)).toEqual([`2210 ${amount.toFixed(2)} / 0.00`, `${bankCode} 0.00 / ${amount.toFixed(2)}`]);
    const [row] = await admin<{ id: string; kind: string; challan_no: string; amount: string; bills: number; expenses: number; runs: number; run_amount: string }[]>`
      select c.id, c.kind, c.challan_no, c.amount::text,
        (select count(*)::int from public.withholding_challan_entries x where x.challan_id = c.id) as bills,
        (select count(*)::int from public.challan_expense_entries x where x.challan_id = c.id) as expenses,
        (select count(*)::int from public.challan_payroll_runs x where x.challan_id = c.id) as runs,
        (select amount::text from public.challan_payroll_runs x where x.challan_id = c.id) as run_amount
      from public.withholding_challans c where c.tenant_id = ${tenantA} and c.number = ${number}`;
    expect(row).toMatchObject({ kind: "income_tax", challan_no: "IT-20261114-0007", amount: amount.toFixed(2), bills: 1, expenses: 1, runs: 1, run_amount: october.tax });
    const audit = await admin<{ after: Record<string, unknown> }[]>`select after from public.audit_log where tenant_id = ${tenantA} and action = 'withholding_challan.record' and entity_id = ${row.id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ number, kind: "income_tax", amount: amount.toFixed(2), entries: 1, expenseEntries: 1, payrollRuns: 1 });
    // The account comes down by what was paid, and the register still equals it: what is left is the second bill's 1,000 and the province's 3,000.
    expect(await books("2026-11-30")).toBe(before.minus(amount).toFixed(2));
    const rows = await agreed("2026-11-30");
    expect(rows.slice(-6)).toEqual([
      "Still to be paid to the government, as at the end of 30-11-2026 |  |  |  |  |  |  |  |  |  |  | ",
      " | Income tax |  |  |  |  |  |  |  | 1000.00 |  | ",
      " | Provincial sales tax |  |  |  |  |  |  |  | 3000.00 |  | ",
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 4000.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 4000.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    // Each line it paid names the challan and its day.
    expect(rows).toContainEqual(expect.stringMatching(new RegExp(`^12-11-2026 \\| Karachi Motors \\(Pvt\\) Ltd \\| 7654321 \\| ${expense.number} \\| KM-SRV-9 \\| .+ \\| 6440\\.00 \\| IT-20261114-0007 \\| 14-11-2026$`)));
    expect(rows).toContainEqual(expect.stringMatching(new RegExp(`^31-10-2026 \\| Salaries for October 2026 \\|  \\| ${october.number} \\|  \\| Salary, 1 person taxed \\|  \\| .+ \\| ${october.tax.replace(".", "\\.")} \\| IT-20261114-0007 \\| 14-11-2026$`)));
    // The day before the challan it was all still to be paid, in the register and in the books of that day.
    expect((await agreed("2026-11-13")).at(-3)).toBe(` | Withheld and not yet paid over |  |  |  |  |  |  |  | ${amount.plus(4000).toFixed(2)} |  | `);
    // Section 165 carries the challan's number on the expense's line.
    const statement = show(await getPurchaseReport(as.accountant, "section-165", toDay("2026-11-30")));
    expect(statement).toContainEqual(expect.stringMatching(new RegExp(`\\| ${expense.number} \\| KM-SRV-9 \\| 12-11-2026 \\| 23000\\.00 \\| 28\\.00 \\| 6440\\.00 \\| IT-20261114-0007 \\| 14-11-2026$`)));
    // Nothing of it is offered again.
    const other = await listOtherTaxUnpaid(as.owner);
    expect(other.expenses.map((e) => e.kind)).toEqual(["provincial_sales_tax"]);
    expect(other.salaries).toEqual([]);
  });

  it("pays each amount once, and writes what it paid once", async () => {
    const refused = "A challan pays whole amounts of its own kind of tax";
    await expect(recordTaxChallan(as.owner, challan({ challanNo: "IT-AGAIN", expenseEntryIds: [expenseIncomeTax] }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ challanNo: "IT-AGAIN", runIds: [october.id] }))).rejects.toThrow(refused);
    await expect(recordTaxChallan(as.owner, challan({ challanNo: "IT-AGAIN", entryIds: [billEntry], expenseEntryIds: [expenseProvincial] }))).rejects.toThrow(refused);
    // The app's role reads the two tables and writes neither.
    const [paid] = await admin<{ challan_id: string }[]>`select challan_id from public.challan_expense_entries where tenant_id = ${tenantA} and entry_id = ${expenseIncomeTax}`;
    expect(await codeOf(as.owner, sql`insert into public.challan_expense_entries (tenant_id, challan_id, entry_id) values (${tenantA}, ${paid.challan_id}, ${expenseProvincial})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.challan_payroll_runs (tenant_id, challan_id, run_id, amount) values (${tenantA}, ${paid.challan_id}, ${novemberDraft}, 1)`)).toBe("42501");
    expect(await codeOf(as.owner, sql`delete from public.challan_expense_entries where entry_id = ${expenseIncomeTax}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.challan_payroll_runs set amount = 1 where run_id = ${october.id}`)).toBe("42501");
    const seen = async (who: TenantContext) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute<{ n: number }>(sql`select (select count(*)::int from public.challan_expense_entries) + (select count(*)::int from public.challan_payroll_runs) as n`)))[0].n;
    expect(await seen(as.auditor)).toBe(2);
    expect(await seen(as.salesperson)).toBe(0);
    expect(await seen(otherOwner)).toBe(0);
    // Someone limited to a branch reads no payroll, so no payroll run's tax here either; and an expense's row only with the expense.
    expect(await seen(north)).toBe(0);
  });

  it("a payroll run whose tax has been paid over stands, as every approved run does: nothing cancels, reverses or changes it", async () => {
    // A challan takes only an approved or paid run (a draft was refused above), and Step 41 lets no approved run go back:
    // its cancel function refuses, the app's role may only work a draft or reviewed run out again, and a run's journal
    // has no way to be reversed, so the tax a challan paid can never leave the books behind it.
    expect(await codeOf(as.owner, sql`select app.cancel_payroll_run(${october.id}::uuid, 'Approved by mistake')`)).toBe("SE354");
    expect(await codeOf(as.owner, sql`update public.payroll_runs set status = 'draft', updated_by = ${userIds.owner} where id = ${october.id}`)).toBe("SE351");
    expect(await codeOf(as.owner, sql`update public.payroll_runs set status = 'cancelled', updated_by = ${userIds.owner} where id = ${october.id}`)).toBe("SE351");
    expect(await codeOf(as.owner, sql`update public.payroll_runs set tax = 0, updated_by = ${userIds.owner} where id = ${october.id}`)).toBe("SE351");
    expect(await codeOf(as.owner, sql`delete from public.payroll_runs where id = ${october.id}`)).toMatch(/^(SE351|42501)$/);
    await expect(workOutRun(as.owner, "2026-10-01")).rejects.toThrow();
    const [made] = await admin<{ reverses: boolean; cancels: number }[]>`
      select to_regprocedure('app.reversal_backed_payroll_run(public.journals, public.journals)') is not null as reverses,
        (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.prosrc ilike '%update public.payroll_runs%' and p.prosrc ilike '%status = ''cancelled''%') as cancels`;
    // No reversal of a run's journal exists, and one function alone sets a run to cancelled: the one that refused above.
    expect(made).toEqual({ reverses: false, cancels: 1 });
    const [row] = await admin<{ status: string; tax: string; paid: string }[]>`
      select r.status, r.tax::numeric(20,2)::text as tax, c.amount::text as paid from public.payroll_runs r join public.challan_payroll_runs c on c.run_id = r.id where r.id = ${october.id}`;
    expect(row).toEqual({ status: "approved", tax: october.tax, paid: october.tax });
    await agreed("2026-11-30");
  });

  it("an expense whose tax has been paid over stands; one whose tax has not can be cancelled, and is then not paid", async () => {
    await expect(cancelExpense(as.owner, expense.id, { date: "2026-11-15", reason: "Entered against the wrong supplier" })).rejects.toThrow("Tax withheld on this expense has been paid to the government under a challan, so the expense stands.");
    // Its page says so in place of the way to cancel it.
    expect((await getExpense(as.owner, expense.id))?.taxPaidOver).toBe(true);
    expect((await admin<{ status: string }[]>`select status from public.expenses where id = ${expense.id}`)[0].status).toBe("posted");
    // A second expense, its tax not yet paid: cancelled on the 16th, and its tax cannot be paid after that.
    const second = await recordExpense(as.accountant, { date: "2026-11-15", accountId: bank, supplierId: supplier, incomeTaxCode: "income_tax.services.other", lines: [{ accountId: repairs, description: "Tyre change", amount: "5000" }] });
    const [{ id: secondTax }] = await admin<{ id: string }[]>`select id from public.expense_withholdings where tenant_id = ${tenantA} and expense_id = ${second.id}`;
    expect((await getExpense(as.owner, second.id))?.taxPaidOver).toBe(false);
    await cancelExpense(as.owner, second.id, { date: "2026-11-16", reason: "Entered twice" });
    await expect(recordTaxChallan(as.owner, challan({ challanNo: "IT-LATE", paidOn: "2026-11-17", expenseEntryIds: [secondTax] }))).rejects.toThrow("A challan pays whole amounts of its own kind of tax");
    expect((await listOtherTaxUnpaid(as.owner)).expenses.map((e) => e.expenseNumber)).toEqual([expense.number]);
    await agreed("2026-11-30");
  });

  it("a challan for the province's tax pays the expense's, and one that pays only bills' entries is still Step 26's", async () => {
    const provincial = await recordTaxChallan(as.owner, challan({ kind: "provincial_sales_tax", challanNo: "SRB-20261118-0003", paidOn: "2026-11-18", expenseEntryIds: [expenseProvincial] }));
    expect(await journal(provincial.number)).toEqual(["2230 3000.00 / 0.00", expect.stringMatching(/ 0\.00 \/ 3000\.00$/)]);
    const plain = await recordTaxChallan(as.accountant, challan({ challanNo: "IT-20261118-0004", paidOn: "2026-11-18", entryIds: [secondBillEntry] }));
    const [row] = await admin<{ bills: number; mine: number }[]>`
      select (select count(*)::int from public.withholding_challan_entries x where x.challan_id = c.id) as bills,
        (select count(*)::int from public.challan_expense_entries x where x.challan_id = c.id) + (select count(*)::int from public.challan_payroll_runs x where x.challan_id = c.id) as mine
      from public.withholding_challans c where c.tenant_id = ${tenantA} and c.number = ${plain.number}`;
    expect(row).toEqual({ bills: 1, mine: 0 });
    // Everything is paid: nothing is still to be paid, and the accounts hold nothing.
    const rows = await agreed("2026-11-30");
    expect(rows.at(-3)).toBe(" | Withheld and not yet paid over |  |  |  |  |  |  |  | 0.00 |  | ");
    expect(await books("2026-11-30")).toBe("0.00");
    expect(await listOtherTaxUnpaid(as.owner)).toEqual({ expenses: [], salaries: [] });
    expect((await getWithholdingPosition(as.owner)).unpaid).toEqual([]);
  });
});
