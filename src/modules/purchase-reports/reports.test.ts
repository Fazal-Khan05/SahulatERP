import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { cancelExpense, recordExpense } from "@/modules/cash-bank/commands";
import { approveRun, reviewRun, workOutRun } from "@/modules/payroll-runs/commands";
import { saveEmployee, setPay } from "@/modules/payroll/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveOrderDraft, saveReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import type { ReportTable } from "@/modules/reports/rules";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import { postPayment, recordChallan, savePaymentDraft } from "@/modules/supplier-payments/commands";
import { getWithholdingPosition } from "@/modules/supplier-payments/queries";
import { postReturn, saveReturnDraft } from "@/modules/supplier-returns/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { getPurchaseReport, listPurchaseReportChoices } from "./queries";
import type { PurchaseFilter } from "./rules";

// The buying reports against a real database, through the app's own path (app_runtime,
// withTenant, row-level security): that each adds up what the documents posted, and that each
// agrees with the books. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-buying-report-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@report.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const november = (over: Partial<PurchaseFilter> = {}): PurchaseFilter => ({ from: "2026-11-01", to: "2026-11-17", branchId: null, supplierId: null, ...over });

let admin: AdminSql;
let plain = "";
let company = "";
let helmet = "";
let bank = "";
let invoiceNo = 0;

const show = (table: ReportTable) => table.rows.map((row) => row.cells.map((cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2))).join(" | "));
/** The balance of locked accounts as a liability (credit less debit), up to the end of a day. */
const books = async (controls: string[], on: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l
      join public.journals j on j.id = l.journal_id join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = any(${controls}) and j.journal_date <= ${on}`
  )[0].v;

/** Helmets ordered, received in full and billed in full: the posted bill, with its line and the goods received note it came on. */
async function billed(supplierId: string, quantity: string, unitCost: string, over: { incomeTaxCode?: string; dueDate?: string } = {}) {
  const order = await saveOrderDraft(as.owner, null, { date: "2026-11-02", supplierId, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity, unitCost }] });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveReceiptDraft(as.warehouse_manager, null, order.id, { date: "2026-11-03", lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postReceipt(as.warehouse_manager, note.id);
  const [{ id: receiptLineId }] = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id}`;
  const draft = await saveBillDraft(as.accountant, null, { date: "2026-11-04", supplierId, branchId: mainBranch, supplierInvoiceNo: `INV-${(invoiceNo += 1)}`, goods: [{ receiptLineId, quantity, unitPrice: unitCost }], ...over });
  const { number } = await postBill(as.accountant, draft.id);
  const [{ id: lineId }] = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where tenant_id = ${tenantA} and bill_id = ${draft.id}`;
  return { id: draft.id, number, lineId, receiptId: note.id, receiptLineId };
}

describe.skipIf(!hasDb)("buying reports", { timeout: 600_000 }, () => {
  let first: Awaited<ReturnType<typeof billed>>;
  let second: Awaited<ReturnType<typeof billed>>;
  let big: Awaited<ReturnType<typeof billed>>;
  let small: Awaited<ReturnType<typeof billed>>;

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
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const [{ id: banks }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1120'`;
    bank = (await addAccount(as.owner, { parentId: banks, name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1500" })).id;
    plain = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
    company = (await createParty(as.owner, "supplier", { name: "Karachi Motors (Pvt) Ltd", supplierType: "company", ntn: "7654321" })).id;
    await setWithholding(as.owner, true);

    // 4 November: Lahore Parts bills 2,400 and 3,900. Karachi Motors bills 1,00,000 (due in a month)
    // and 10,000; 10% income tax is withheld on both, so 90,000 and 9,000 are owed.
    first = await billed(plain, "4", "600");
    second = await billed(plain, "6", "650");
    big = await billed(company, "100", "1000", { incomeTaxCode: "income_tax.goods.company", dueDate: "2026-12-04" });
    small = await billed(company, "10", "1000", { incomeTaxCode: "income_tax.goods.company" });
    // 6 November: 3,400 pays the first Lahore bill and 1,000 of the second; 700 goes ahead to Karachi Motors.
    const pay = await savePaymentDraft(as.accountant, null, { date: "2026-11-06", supplierId: plain, branchId: mainBranch, accountId: bank, amount: "3400", allocations: [{ billId: first.id, amount: "2400" }, { billId: second.id, amount: "1000" }] });
    await postPayment(as.accountant, pay.id, pay.updatedAt);
    const ahead = await savePaymentDraft(as.accountant, null, { date: "2026-11-06", supplierId: company, branchId: mainBranch, accountId: bank, amount: "700" });
    await postPayment(as.accountant, ahead.id, ahead.updatedAt);
    // 7 November: one helmet of the second Lahore bill goes back: 650 comes off it.
    const back = await saveReturnDraft(as.accountant, null, { date: "2026-11-07", receiptId: second.receiptId, reason: "Cracked shell", lines: [{ receiptLineId: second.receiptLineId, billLineId: second.lineId, quantity: "1" }] });
    await postReturn(as.accountant, back.id, back.updatedAt);
    // 10 November: the 10,000 withheld on the big bill is paid to the government.
    const [entry] = (await getWithholdingPosition(as.accountant)).unpaid.filter((row) => row.amount.eq(new Decimal("10000")));
    await recordChallan(as.accountant, { kind: "income_tax", paidOn: "2026-11-10", accountId: bank, challanNo: "IT-20261110-0001", entryIds: [entry.entryId] });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 240_000);

  it("aged payables: what is owed on each bill by how long it has been due, less what the supplier holds, agreeing with the books", async () => {
    const table = await getPurchaseReport(as.auditor, "aged-payables", november());
    expect(table.period).toBe("As at the end of 17-11-2026");
    expect(show(table)).toEqual([
      // 90,000 is not due until December; 9,000 fell due on the 4th; 700 was paid ahead.
      "Karachi Motors (Pvt) Ltd |  |  | 90000.00 | 9000.00 |  |  |  | 99000.00 | 700.00 | 98300.00",
      // 3,900 less the 1,000 paid and the 650 sent back.
      "Lahore Parts |  |  |  | 2250.00 |  |  |  | 2250.00 |  | 2250.00",
      "Total |  |  | 90000.00 | 11250.00 | 0.00 | 0.00 | 0.00 | 101250.00 | 700.00 | 100550.00",
      "Trade payables less advances to suppliers, in the books |  |  |  |  |  |  |  |  |  | 100550.00",
      "Difference |  |  |  |  |  |  |  |  |  | 0.00",
    ]);
    expect(await books(["ap", "supplier_advances"], "2026-11-17")).toBe("100550.00");
    // As at the 5th, before anything was paid or sent back: every bill in full, and the books of that day agree.
    const earlier = await getPurchaseReport(as.auditor, "aged-payables", november({ to: "2026-11-05" }));
    expect(show(earlier).slice(-3)).toEqual([
      "Total |  |  | 90000.00 | 15300.00 | 0.00 | 0.00 | 0.00 | 105300.00 | 0.00 | 105300.00",
      "Trade payables less advances to suppliers, in the books |  |  |  |  |  |  |  |  |  | 105300.00",
      "Difference |  |  |  |  |  |  |  |  |  | 0.00",
    ]);
    // Before any bill: nothing.
    expect(show(await getPurchaseReport(as.auditor, "aged-payables", november({ to: "2026-11-03" }))).at(0)).toBe("Total |  |  | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00");
    // One supplier: each bill is listed, and the books are that supplier's.
    const one = await getPurchaseReport(as.accountant, "aged-payables", november({ supplierId: company }));
    expect(show(one)).toEqual([
      "Karachi Motors (Pvt) Ltd |  |  |  |  |  |  |  |  |  | ",
      `${big.number} (INV-3) | 04-11-2026 | 04-12-2026 | 90000.00 |  |  |  |  | 90000.00 |  | `,
      `${small.number} (INV-4) | 04-11-2026 | 04-11-2026 |  | 9000.00 |  |  |  | 9000.00 |  | `,
      "Total, Karachi Motors (Pvt) Ltd |  |  | 90000.00 | 9000.00 |  |  |  | 99000.00 | 700.00 | 98300.00",
      "Total |  |  | 90000.00 | 9000.00 | 0.00 | 0.00 | 0.00 | 99000.00 | 700.00 | 98300.00",
      "Trade payables less advances to suppliers, in the books |  |  |  |  |  |  |  |  |  | 98300.00",
      "Difference |  |  |  |  |  |  |  |  |  | 0.00",
    ]);
    expect(one.notes).toEqual(["A bill is aged from the day it is due; one with no due date, from its own date."]);
  });

  it("a supplier's statement: every bill, payment and return in the period, with what was owed before and after", async () => {
    const table = await getPurchaseReport(as.accountant, "supplier-statement", november({ supplierId: plain }));
    expect(table.title).toBe("Supplier statement: Lahore Parts");
    expect(show(table)).toEqual([
      " | Owed before |  |  |  | 0.00",
      `04-11-2026 | Bill ${first.number} | Bill INV-1 from Lahore Parts | 2400.00 |  | 2400.00`,
      `04-11-2026 | Bill ${second.number} | Bill INV-2 from Lahore Parts | 3900.00 |  | 6300.00`,
      "06-11-2026 | Payment PV-2627-00001 | Paid to Lahore Parts |  | 3400.00 | 2900.00",
      expect.stringMatching(/^07-11-2026 \| Goods sent back DB-2627-00001 \| Goods sent back to Lahore Parts from GR-2627-\d{5} \|  \| 650\.00 \| 2250\.00$/),
      " | Owed after |  | 6300.00 | 4050.00 | 2250.00",
    ]);
    // From the 6th on: what was billed before is what was owed before.
    expect(show(await getPurchaseReport(as.accountant, "supplier-statement", november({ supplierId: plain, from: "2026-11-06" }))).at(0)).toBe(" | Owed before |  |  |  | 6300.00");
    // Money sent ahead leaves the supplier holding the company's money.
    const ahead = await getPurchaseReport(as.accountant, "supplier-statement", november({ supplierId: company, from: "2026-11-05" }));
    expect(show(ahead)).toEqual([" | Owed before |  |  |  | 99000.00", "06-11-2026 | Payment PV-2627-00002 | Paid to Karachi Motors (Pvt) Ltd |  | 700.00 | 98300.00", " | Owed after |  | 0.00 | 700.00 | 98300.00"]);
    expect((await getPurchaseReport(as.accountant, "supplier-statement", november())).notes).toEqual(["Choose a supplier to see its statement."]);
    expect((await listPurchaseReportChoices(as.auditor)).suppliers.map((row) => row.label)).toEqual(["Karachi Motors (Pvt) Ltd", "Lahore Parts"]);
  });

  it("the plan's test: the withholding register's total of what is still to be paid over equals the withholding payable accounts", async () => {
    const table = await getPurchaseReport(as.auditor, "withholding-register", november());
    expect(show(table)).toEqual([
      "Income tax |  |  |  |  |  |  |  |  |  |  | ",
      expect.stringMatching(new RegExp(`^04-11-2026 \\| Karachi Motors \\(Pvt\\) Ltd \\| 7654321 \\| ${big.number} \\| INV-3 \\| .+ \\| No \\| 100000\\.00 \\| 10\\.00 \\| 10000\\.00 \\| IT-20261110-0001 \\| 10-11-2026$`)),
      expect.stringMatching(new RegExp(`^04-11-2026 \\| Karachi Motors \\(Pvt\\) Ltd \\| 7654321 \\| ${small.number} \\| INV-4 \\| .+ \\| No \\| 10000\\.00 \\| 10\\.00 \\| 1000\\.00 \\|  \\| $`)),
      " | Total, income tax |  |  |  |  |  |  |  | 11000.00 |  | ",
      " | Withheld in the period |  |  |  |  |  |  |  | 11000.00 |  | ",
      "Still to be paid to the government, as at the end of 17-11-2026 |  |  |  |  |  |  |  |  |  |  | ",
      " | Income tax |  |  |  |  |  |  |  | 1000.00 |  | ",
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 1000.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 1000.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    expect(table.notes).toEqual([]);
    // The same account, read straight from the books.
    expect(await books(["wht_income_tax", "wht_sales_tax", "wht_provincial_tax"], "2026-11-17")).toBe("1000.00");
    // The day before the challan: all 11,000 was still to be paid, and the books of that day say so too.
    const before = show(await getPurchaseReport(as.auditor, "withholding-register", november({ to: "2026-11-09" })));
    expect(before.slice(-3)).toEqual([
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 11000.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 11000.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    expect(await books(["wht_income_tax"], "2026-11-09")).toBe("11000.00");
    // For one supplier the comparison is left out: challans are the whole company's.
    const one = await getPurchaseReport(as.auditor, "withholding-register", november({ supplierId: company }));
    expect(show(one).at(-1)).toBe(" | Withheld in the period |  |  |  |  |  |  |  | 11000.00 |  | ");
    expect(one.notes[0]).toMatch(/challans are for the whole company/);
    expect(show(await getPurchaseReport(as.auditor, "withholding-register", november({ supplierId: plain })))).toEqual([" | Withheld in the period |  |  |  |  |  |  |  | 0.00 |  | "]);
  });

  it("the statement for section 165: the income tax withheld in the period, payee by payee", async () => {
    const table = await getPurchaseReport(as.accountant, "section-165", november());
    expect(table.columns.map((column) => column.label)).toEqual(["Section", "NTN", "CNIC", "Name of the payee", "Status", "On the Active Taxpayers List", "Bill", "Their invoice", "Date", "Amount on which tax was withheld", "Rate %", "Tax withheld", "CPR number", "CPR date"]);
    expect(show(table)).toEqual([
      expect.stringMatching(new RegExp(`153.* \\| 7654321 \\|  \\| Karachi Motors \\(Pvt\\) Ltd \\| Company \\| No \\| ${big.number} \\| INV-3 \\| 04-11-2026 \\| 100000\\.00 \\| 10\\.00 \\| 10000\\.00 \\| IT-20261110-0001 \\| 10-11-2026$`)),
      expect.stringMatching(new RegExp(`153.* \\| 7654321 \\|  \\| Karachi Motors \\(Pvt\\) Ltd \\| Company \\| No \\| ${small.number} \\| INV-4 \\| 04-11-2026 \\| 10000\\.00 \\| 10\\.00 \\| 1000\\.00 \\|  \\| $`)),
      " |  |  | Total |  |  |  |  |  | 110000.00 |  | 11000.00 |  | ",
    ]);
    expect(table.notes.at(-1)).toBe("Some of this tax has not been paid over yet: it has no CPR number.");
    // Outside the quarter asked for: nothing.
    expect(show(await getPurchaseReport(as.accountant, "section-165", november({ from: "2026-07-01", to: "2026-09-30" })))).toEqual([" |  |  | Total |  |  |  |  |  | 0.00 |  | 0.00 |  | "]);
  });

  it("goods received, not yet billed, as a report: nothing is waiting, and the account in the books is nil", async () => {
    const order = await saveOrderDraft(as.owner, null, { date: "2026-11-02", supplierId: plain, warehouseId: mainWarehouse, lines: [{ itemId: helmet, quantity: "3", unitCost: "600" }] });
    await submitOrder(as.owner, order.id);
    const placed = await getOrder(as.owner, order.id);
    const note = await saveReceiptDraft(as.warehouse_manager, null, order.id, { date: "2026-11-03", lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
    await postReceipt(as.warehouse_manager, note.id);
    const table = await getPurchaseReport(as.auditor, "grni", november());
    expect(show(table)).toEqual([
      expect.stringMatching(/^GR-2627-\d{5} \| 03-11-2026 \| Lahore Parts \| PO-2627-\d{5} \| HL-1 \| Helmet \| 3 pc \| 1800\.00$/),
      " |  |  |  |  | Total |  | 1800.00",
      " |  |  |  |  | Goods received not invoiced, in the books |  | 1800.00",
      " |  |  |  |  | Difference |  | 0.00",
    ]);
  });

  it("the register also holds tax withheld on an expense and the salary tax of approved payroll runs, and still equals the books", async () => {
    const last = (table: ReportTable, n: number) => show(table).slice(-n);
    const agreed = (table: ReportTable) => expect(last(table, 1)).toEqual([" | Difference |  |  |  |  |  |  |  | 0.00 |  | "]);
    // 12 November: van repairs of 20,000 paid to Karachi Motors out of the bank (Step 34). Sindh's
    // tax on services, 15%, is added and withheld whole; income tax is 28% of the 23,000, since
    // the supplier is not on the Active Taxpayers List.
    const [{ id: repairs }] = await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '5270'`;
    const expense = await recordExpense(as.accountant, { date: "2026-11-12", accountId: bank, supplierId: company, reference: "KM-SRV-9", incomeTaxCode: "income_tax.services.other", provincialTaxCode: "provincial_sales_tax.sindh", lines: [{ accountId: repairs, description: "Van repairs", amount: "20000" }] });
    let table = await getPurchaseReport(as.auditor, "withholding-register", november());
    expect(show(table)).toContainEqual(expect.stringMatching(new RegExp(`^12-11-2026 \\| Karachi Motors \\(Pvt\\) Ltd \\| 7654321 \\| ${expense.number} \\| KM-SRV-9 \\| .+ \\| No \\| 23000\\.00 \\| 28\\.00 \\| 6440\\.00 \\|  \\| $`)));
    expect(show(table)).toContainEqual(expect.stringMatching(new RegExp(`^12-11-2026 \\| Karachi Motors \\(Pvt\\) Ltd \\| 7654321 \\| ${expense.number} \\| KM-SRV-9 \\| .+ \\| No \\| 20000\\.00 \\| 15\\.00 \\| 3000\\.00 \\|  \\| $`)));
    expect(last(table, 6)).toEqual([
      "Still to be paid to the government, as at the end of 17-11-2026 |  |  |  |  |  |  |  |  |  |  | ",
      " | Income tax |  |  |  |  |  |  |  | 7440.00 |  | ",
      " | Provincial sales tax |  |  |  |  |  |  |  | 3000.00 |  | ",
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 10440.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 10440.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    expect(await books(["wht_income_tax", "wht_sales_tax", "wht_provincial_tax"], "2026-11-17")).toBe("10440.00");
    expect(table.notes).toEqual([]);

    // October's payroll, approved: one person paid enough to be taxed. The run credits its tax to
    // the same account as income tax withheld from suppliers (Step 41).
    const employee = await saveEmployee(as.owner, null, { code: "E-001", name: "Imran Qureshi", province: "sindh", payBasis: "monthly", joinedOn: "2026-07-01" });
    await setPay(as.owner, employee.id, { component: "basic", amount: "200000", effectiveFrom: "2026-07-01" });
    const worked = await workOutRun(as.owner, "2026-10-01");
    if (!("id" in worked)) throw new Error(worked.problems.map((p) => p.reason).join("; "));
    await reviewRun(as.owner, worked.id);
    const run = await approveRun(as.accountant, worked.id);
    const [{ tax, taxable }] = await admin<{ tax: string; taxable: string }[]>`
      select r.tax::numeric(20,2)::text as tax, (select sum(p.taxable)::numeric(20,2)::text from public.payslips p where p.run_id = r.id) as taxable from public.payroll_runs r where r.tenant_id = ${tenantA} and r.number = ${run.number}`;
    expect(Number(tax)).toBeGreaterThan(0);
    // In November's register the run is not of the period, and its tax is still to be paid: the two agree again.
    table = await getPurchaseReport(as.auditor, "withholding-register", november());
    expect(show(table).some((row) => row.includes("Salaries for"))).toBe(false);
    expect(last(table, 5)).toEqual([
      " | Provincial sales tax |  |  |  |  |  |  |  | 3000.00 |  | ",
      ` | Income tax deducted from salaries (section 149) |  |  |  |  |  |  |  | ${tax} |  | `,
      ` | Withheld and not yet paid over |  |  |  |  |  |  |  | ${new Decimal(tax).plus("10440").toFixed(2)} |  | `,
      ` | Withholding payable accounts in the books |  |  |  |  |  |  |  | ${new Decimal(tax).plus("10440").toFixed(2)} |  | `,
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    // From October on, the run has a section of its own, from the run's own figures.
    table = await getPurchaseReport(as.auditor, "withholding-register", november({ from: "2026-10-01" }));
    expect(show(table)).toEqual(expect.arrayContaining([
      "Income tax deducted from salaries (section 149) |  |  |  |  |  |  |  |  |  |  | ",
      `31-10-2026 | Salaries for October 2026 |  | ${run.number} |  | Salary, 1 person taxed |  | ${taxable} |  | ${tax} |  | `,
      ` | Total, income tax deducted from salaries |  |  |  |  |  |  |  | ${tax} |  | `,
    ]));
    agreed(table);
    // The day before the run's journal, the books did not hold its tax, and the register does not count it.
    agreed(await getPurchaseReport(as.auditor, "withholding-register", november({ from: "2026-10-01", to: "2026-10-30" })));
    // For one supplier or one branch, salaries are left out with the comparison: payroll is the whole company's.
    expect(show(await getPurchaseReport(as.auditor, "withholding-register", november({ from: "2026-10-01", supplierId: company }))).some((row) => row.includes("Salaries for"))).toBe(false);

    // Section 165 is the suppliers' statement: the expense's income tax is in it, salaries are not.
    const statement = await getPurchaseReport(as.accountant, "section-165", november({ from: "2026-10-01" }));
    expect(show(statement)).toContainEqual(expect.stringMatching(new RegExp(`153.* \\| 7654321 \\|  \\| Karachi Motors \\(Pvt\\) Ltd \\| Company \\| No \\| ${expense.number} \\| KM-SRV-9 \\| 12-11-2026 \\| 23000\\.00 \\| 28\\.00 \\| 6440\\.00 \\|  \\| $`)));
    expect(show(statement).at(-1)).toBe(" |  |  | Total |  |  |  |  |  | 133000.00 |  | 17440.00 |  | ");
    expect(show(statement).some((row) => row.includes("Salar") || row.includes(run.number))).toBe(false);
    expect(statement.notes).toContainEqual(expect.stringMatching(/^Income tax deducted from salaries \(section 149\) is not in this statement/));

    // The expense is cancelled on the 13th: its tax goes back, and from that day the register no longer holds it.
    await cancelExpense(as.owner, expense.id, { date: "2026-11-13", reason: "Entered against the wrong supplier" });
    table = await getPurchaseReport(as.auditor, "withholding-register", november());
    expect(show(table).some((row) => row.includes(expense.number))).toBe(false);
    agreed(table);
    expect(await books(["wht_income_tax", "wht_sales_tax", "wht_provincial_tax"], "2026-11-17")).toBe(new Decimal(tax).plus("1000").toFixed(2));
    // As at the 12th it still stood, in the register and in the books of that day.
    table = await getPurchaseReport(as.auditor, "withholding-register", november({ to: "2026-11-12" }));
    expect(show(table).some((row) => row.includes(expense.number))).toBe(true);
    agreed(table);
  });

  it("keeps the reports to those who keep or check the books, in their branches and their company", async () => {
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      for (const report of ["aged-payables", "supplier-statement", "withholding-register", "section-165", "grni"] as const) {
        await expect(getPurchaseReport(as[role], report, november()), `${role} ${report}`).rejects.toThrow("Only an owner, an accountant or an auditor can see what is owed to suppliers.");
      }
      expect((await listPurchaseReportChoices(as[role])).suppliers).toEqual([]);
    }
    // An accountant of the north branch sees none of the main branch's bills, and no comparison with the whole company's challans.
    expect(show(await getPurchaseReport(north, "aged-payables", november()))[0]).toMatch(/^Total \|/);
    const register = await getPurchaseReport(north, "withholding-register", november());
    expect(show(register)).toEqual([" | Withheld in the period |  |  |  |  |  |  |  | 0.00 |  | "]);
    expect(show(await getPurchaseReport(north, "supplier-statement", november({ supplierId: plain })))).toEqual([" | Owed before |  |  |  | 0.00", " | Owed after |  | 0.00 | 0.00 | 0.00"]);
    // Another company sees nothing, and another company's supplier is no supplier at all.
    expect(show(await getPurchaseReport(otherOwner, "aged-payables", november()))[0]).toMatch(/^Total \|/);
    expect((await getPurchaseReport(otherOwner, "supplier-statement", november({ supplierId: plain }))).notes).toEqual(["Choose a supplier to see its statement."]);
  });
});
