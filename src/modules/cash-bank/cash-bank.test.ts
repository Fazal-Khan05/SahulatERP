import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { setWithholding } from "@/modules/supplier-bills/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addCashBankAccount, archiveCashBankAccount, cancelExpense, cancelTransfer, recordExpense, recordTransfer, saveBankDetails } from "./commands";
import { getExpense, getExpenseChoices, listCashBankAccounts, listExpenses, listTransfers } from "./queries";

// Step 34 against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): cash and bank accounts, transfers between them, expenses with the tax
// withheld from them, cancelling either by a reversal, and archiving an account only when it
// holds nothing. The figures are those of docs/examples/step-34.md. Skipped when the database
// URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-cash-bank-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const lahoreBranch = randomUUID();
const branchClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@cash.test`, tenantId: tenantA, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const lahoreAccountant = ctx(branchClerk, "accountant", [lahoreBranch]);
const DAY = "2026-10-20";

let admin: AdminSql;
let cash: string;
let bank: string;
let petty: string;
let repairs: string;
let fuel: string;
let charges: string;
let lahoreParts: string;

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
      select a.code || ' ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantA} and j.document_number = ${number} order by l.line_no`
  ).map((r) => r.line);
const balanceOf = async (account: string) => (await listCashBankAccounts(as.owner)).find((a) => a.id === account)!.balance.toFixed(2);
const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;

describe.skipIf(!hasDb)("cash and bank: accounts, transfers and expenses", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${lahoreBranch}, ${tenantA}, 'Lahore', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: branchClerk, email: lahoreAccountant.email, role: "accountant", branch_ids: [lahoreBranch], created_by: userIds.owner },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    // The tax tables a company is given when it is made through the app, with Step 25's withholding lines.
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    cash = await account("1111");
    repairs = await account("5270");
    charges = await account("5810");
    fuel = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and type = 'expense' and not is_group and control_type is null and code <> '5270' order by code limit 1`)[0].id;
    lahoreParts = (await createParty(as.owner, "supplier", { name: "Lahore Parts", supplierType: "aop" })).id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("adds a bank account with its details, and petty cash as one more cash account", async () => {
    bank = (await addCashBankAccount(as.accountant, { kind: "bank", name: "HBL current account", bankName: "Habib Bank Limited", accountNumber: "PK36HABB0000001123456702" })).id;
    petty = (await addCashBankAccount(as.owner, { kind: "cash", name: "Petty cash" })).id;
    const listed = await listCashBankAccounts(as.auditor);
    expect(listed.map((a) => `${a.kind} ${a.name} ${a.bankName ?? ""} ${a.balance.toFixed(2)}`)).toEqual(["bank HBL current account Habib Bank Limited 0.00", "cash Cash in hand  0.00", "cash Petty cash  0.00"]);
    await saveBankDetails(as.owner, bank, { bankName: "HBL", accountNumber: "PK36HABB0000001123456702" });
    expect((await listCashBankAccounts(as.owner)).find((a) => a.id === bank)?.bankName).toBe("HBL");
    await expect(saveBankDetails(as.owner, cash, { bankName: "HBL" })).rejects.toThrow("Bank details belong to a bank account");
    await expect(addCashBankAccount(as.owner, { kind: "cash", name: "Till", bankName: "HBL" })).rejects.toThrow("A cash account has no bank");
  });

  it("moves money between two accounts, and takes a transfer back by a reversal", async () => {
    const { number } = await recordTransfer(as.accountant, { fromId: bank, toId: petty, date: DAY, amount: "15,000", reference: "Cheque 1001", memo: "Petty cash for October" });
    expect(number).toBe("TR-2627-00001");
    expect(await journal(number)).toEqual([`${(await listCashBankAccounts(as.owner)).find((a) => a.id === petty)!.code} 15000 / 0`, `${(await listCashBankAccounts(as.owner)).find((a) => a.id === bank)!.code} 0 / 15000`]);
    expect([await balanceOf(bank), await balanceOf(petty)]).toEqual(["-15000.00", "15000.00"]);
    const second = await recordTransfer(as.owner, { fromId: cash, toId: petty, date: DAY, amount: "500" });
    const [row] = await admin<{ id: string }[]>`select id from public.cash_transfers where tenant_id = ${tenantA} and number = ${second.number}`;
    await cancelTransfer(as.owner, row.id, { date: DAY, reason: "Entered twice" });
    expect([await balanceOf(cash), await balanceOf(petty)]).toEqual(["0.00", "15000.00"]);
    expect((await listTransfers(as.auditor)).map((t) => `${t.number} ${t.status}`)).toEqual(["TR-2627-00002 cancelled", "TR-2627-00001 posted"]);
    await expect(cancelTransfer(as.owner, row.id, { date: DAY, reason: "Again" })).rejects.toThrow("It has already been cancelled.");
    await expect(recordTransfer(as.owner, { fromId: petty, toId: petty, date: DAY, amount: "1" })).rejects.toThrow("Money is moved between two different accounts.");
    await expect(recordTransfer(as.owner, { fromId: petty, toId: repairs, date: DAY, amount: "1" })).rejects.toThrow("Choose two different cash or bank accounts");
    await expect(recordTransfer(as.owner, { fromId: bank, toId: petty, date: "2099-01-01", amount: "1" })).rejects.toThrow("That date has not come yet.");
  });

  it("acceptance: an expense with the province's tax on services withheld posts correctly", async () => {
    // docs/examples/step-34.md: Lahore Parts, not on the Active Taxpayers List, repairs the shop
    // front for 30,000 and paints it for 20,000; Punjab's 16% on 50,000 is 8,000, withheld whole;
    // income tax at 28% of 58,000 is 16,240; 33,760 leaves the bank.
    await setWithholding(as.owner, true);
    const made = await recordExpense(as.accountant, {
      date: DAY,
      accountId: bank,
      supplierId: lahoreParts,
      reference: "Inv 4471",
      incomeTaxCode: "income_tax.services.other",
      provincialTaxCode: "provincial_sales_tax.punjab",
      lines: [
        { accountId: repairs, description: "Shop front repairs", amount: "30000" },
        { accountId: repairs, description: "Painting", amount: "20,000" },
      ],
    });
    expect(made.number).toBe("EX-2627-00001");
    const bankCode = (await listCashBankAccounts(as.owner)).find((a) => a.id === bank)!.code;
    expect(await journal(made.number)).toEqual(["5270 34800 / 0", "5270 23200 / 0", "2230 0 / 8000", "2210 0 / 16240", `${bankCode} 0 / 33760`]);
    const found = (await getExpense(as.auditor, made.id))!;
    expect([found.amount, found.provincialTax, found.total, found.withheld, found.paid].map((d) => d.toFixed(2))).toEqual(["50000.00", "8000.00", "58000.00", "24240.00", "33760.00"]);
    expect(found.withholdings.map((w) => `${w.kind} ${w.base.toFixed(2)} at ${w.rate.toFixed()}% = ${w.amount.toFixed(2)} ${w.onActiveList ? "on list" : "not on list"}`)).toEqual([
      "provincial_sales_tax 50000.00 at 16% = 8000.00 not on list",
      "income_tax 58000.00 at 28% = 16240.00 not on list",
    ]);
    expect(found.lines.map((l) => `${l.amount.toFixed(2)} + ${l.provincialShare.toFixed(2)}`)).toEqual(["30000.00 + 4800.00", "20000.00 + 3200.00"]);
    expect(await balanceOf(bank)).toBe("-48760.00");
  });

  it("pays a payee named in words with no tax withheld, out of petty cash, and spends on bank charges", async () => {
    const tea = await recordExpense(as.owner, { date: DAY, accountId: petty, payee: "Tea stall", lines: [{ accountId: fuel, description: "Tea for the staff", amount: "1,200" }] });
    const pettyCode = (await listCashBankAccounts(as.owner)).find((a) => a.id === petty)!.code;
    expect(await journal(tea.number)).toEqual([`${(await admin<{ code: string }[]>`select code from public.accounts where id = ${fuel}`)[0].code} 1200 / 0`, `${pettyCode} 0 / 1200`]);
    const fee = await recordExpense(as.owner, { date: DAY, accountId: bank, payee: "HBL", lines: [{ accountId: charges, description: "Cheque book", amount: "300" }] });
    expect((await journal(fee.number))[0]).toBe("5810 300 / 0");
    expect(await balanceOf(petty)).toBe("13800.00");
  });

  it("refuses what will not do, in plain words", async () => {
    const line = [{ accountId: repairs, description: "Repairs", amount: "100" }];
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, lines: line })).rejects.toThrow("Choose the supplier, or name who was paid.");
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, payee: "Someone", incomeTaxCode: "income_tax.services.other", lines: line })).rejects.toThrow("Tax is withheld from a supplier on the list");
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, payee: "Someone", lines: [{ accountId: bank, description: "Not an expense", amount: "1" }] })).rejects.toThrow("A line, or the tax withheld, will not do");
    await expect(recordExpense(as.owner, { date: DAY, accountId: repairs, payee: "Someone", lines: line })).rejects.toThrow("Choose two different cash or bank accounts");
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, payee: "Someone", lines: [{ accountId: repairs, description: "", amount: "100" }] })).rejects.toThrow("Line 1: say what it was for.");
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, supplierId: lahoreParts, incomeTaxCode: "income_tax.nothing", lines: line })).rejects.toThrow("That withholding line is not in force");
    // A company that does not withhold withholds nothing.
    await setWithholding(as.owner, false);
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, supplierId: lahoreParts, provincialTaxCode: "provincial_sales_tax.punjab", lines: line })).rejects.toThrow("only by a company that withholds");
    await setWithholding(as.owner, true);
  });

  it("takes an expense back by a reversal: the expense, the tax withheld and the money", async () => {
    const [first] = await admin<{ id: string }[]>`select id from public.expenses where tenant_id = ${tenantA} and number = 'EX-2627-00001'`;
    await cancelExpense(as.owner, first.id, { date: DAY, reason: "Wrong supplier" });
    const found = (await getExpense(as.owner, first.id))!;
    expect(found.status).toBe("cancelled");
    expect(found.reversal.map((l) => `${l.debit.toFixed(2)} / ${l.credit.toFixed(2)}`)).toEqual(["0.00 / 34800.00", "0.00 / 23200.00", "8000.00 / 0.00", "16240.00 / 0.00", "33760.00 / 0.00"]);
    expect(await balanceOf(bank)).toBe("-15300.00");
    const [owed] = await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type in ('wht_income_tax', 'wht_provincial_tax')`;
    expect(owed.v).toBe("0.00");
  });

  it("archives a cash or bank account only when it holds nothing", async () => {
    await expect(archiveCashBankAccount(as.owner, petty)).rejects.toThrow("This account holds 13,800.00");
    // Past the app, the database refuses it too.
    expect(await codeOf(as.owner, sql`update public.accounts set archived_at = now(), archived_by = ${userIds.owner} where id = ${petty}`)).toBe("SE340");
    await recordTransfer(as.owner, { fromId: petty, toId: bank, date: DAY, amount: "13800" });
    await archiveCashBankAccount(as.owner, petty);
    expect((await listCashBankAccounts(as.owner)).find((a) => a.id === petty)?.archived).toBe(true);
    await expect(recordTransfer(as.owner, { fromId: bank, toId: petty, date: DAY, amount: "1" })).rejects.toThrow("Choose two different cash or bank accounts");
  });

  it("is kept by the owner and an accountant, read by the auditor, and hidden from everyone else", async () => {
    for (const role of ["auditor", "salesperson", "recovery_officer"] as const) {
      await expect(recordTransfer(as[role], { fromId: bank, toId: cash, date: DAY, amount: "1" }), role).rejects.toThrow("Only the owner or an accountant");
      expect(await codeOf(as[role], sql`select app.record_cash_transfer(${bank}::uuid, ${cash}::uuid, ${DAY}::date, 1, null, null)`), role).toBe("42501");
    }
    expect((await listExpenses(as.auditor)).length).toBe(3);
    await expect(listExpenses(as.salesperson)).rejects.toThrow("Your role does not include cash and bank.");
    const seen = await withTenant(userIds.salesperson, tenantA, (tx) => tx.execute<{ n: number }>(sql`select (select count(*)::int from public.expenses) + (select count(*)::int from public.cash_transfers) as n`));
    expect(seen[0].n).toBe(0);
    // A branch's accountant spends for their branch, sees that branch's expenses, and moves no money between the company's accounts.
    await expect(recordExpense(lahoreAccountant, { date: DAY, accountId: cash, payee: "Plumber", lines: [{ accountId: repairs, description: "Tap", amount: "800" }] })).rejects.toThrow("Choose one of your branches.");
    await recordExpense(lahoreAccountant, { date: DAY, accountId: cash, payee: "Plumber", branchId: lahoreBranch, lines: [{ accountId: repairs, description: "Tap", amount: "800" }] });
    expect((await listExpenses(lahoreAccountant)).map((e) => e.paidTo)).toEqual(["Plumber"]);
    await expect(recordTransfer(lahoreAccountant, { fromId: bank, toId: cash, date: DAY, amount: "1" })).rejects.toThrow("Your role cannot do that.");
  });

  it("offers the withholding lines in force, and says whether the company withholds", async () => {
    const choices = await getExpenseChoices(as.owner, DAY);
    expect(choices.withholds).toBe(true);
    expect(choices.provincialLines.map((l) => `${l.code} ${l.rate.toFixed()}`)).toContain("provincial_sales_tax.punjab 16");
    expect(choices.incomeTaxLines.find((l) => l.code === "income_tax.services.other")?.rule.rateNonAtl?.toFixed()).toBe("28");
    expect(choices.moneyAccounts.map((a) => a.id)).not.toContain(petty);
    expect(choices.expenseAccounts.map((a) => a.id)).toContain(charges);
  });
});
