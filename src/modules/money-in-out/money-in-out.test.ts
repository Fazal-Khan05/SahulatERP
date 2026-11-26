import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { importStatement } from "@/modules/bank-reconciliation/commands";
import { getReconciliationPage } from "@/modules/bank-reconciliation/queries";
import { addCashBankAccount } from "@/modules/cash-bank/commands";
import { listCashBankAccounts } from "@/modules/cash-bank/queries";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { getGeneralLedger } from "@/modules/reports/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { cancelMoneyInOut, recordMoneyInOut } from "./commands";
import { getMoneyInOut, listMoneyInOut, listOtherAccounts } from "./queries";

// Money in and money out against a real database, through the app's own path (app_runtime,
// withTenant, row-level security): the journal each posts, its number, its audit rows, the
// ledger and bank reconciliation, cancelling by a reversal, and what the database refuses: roles,
// a locked period, another company's accounts, a control or expense account. Skipped when the
// database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-money-in-out-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const branch = randomUUID();
const branchClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], tenantId = tenantA, branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@money.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const asB = ctx(ownerB, "owner", tenantB);
const branchAccountant = ctx(branchClerk, "accountant", tenantA, [branch]);
const DAY = "2026-11-20";

let admin: AdminSql;
let cash: string;
let bank: string;
let capital: string;
let drawings: string;
let loans: string;
let receivables: string;
let anExpense: string;
let cashB: string;
let capitalB: string;

const account = async (tenant: string, code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = ${code}`)[0].id;
const journal = async (number: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantA} and j.document_number = ${number} order by l.line_no`
  ).map((r) => r.line);
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const entry = (change: Record<string, unknown> = {}) => ({ direction: "in", date: DAY, moneyAccountId: cash, otherAccountId: capital, amount: "250000", party: "Fazal Khan", reference: "", memo: "", ...change });
const record = (direction: string, money: string, other: string, amount = "1000") =>
  sql`select app.record_money_in_out(${randomUUID()}::uuid, ${direction}, ${DAY}::date, ${money}::uuid, ${other}::uuid, ${amount}::numeric, 'Someone', null, null)`;

describe.skipIf(!hasDb)("money in and money out", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants ${admin([
      { id: tenantA, name: PREFIX + " A", created_by: userIds.owner },
      { id: tenantB, name: PREFIX + " B", created_by: ownerB },
    ])}`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'Lahore', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: branchClerk, email: branchAccountant.email, role: "accountant", branch_ids: [branch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: asB.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    for (const [tenant, who] of [
      [tenantA, as.owner],
      [tenantB, asB],
    ] as const) {
      await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenant}, false, 'trading', ${who.userId})`;
      await setBaseCurrency(who, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(who, "trading");
      await openFiscalYear(who, { month: "7", year: "2026" });
    }
    cash = await account(tenantA, "1111");
    capital = await account(tenantA, "3100");
    drawings = await account(tenantA, "3200");
    loans = await account(tenantA, "2520");
    receivables = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and control_type = 'ar' and not is_group`)[0].id;
    anExpense = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and type = 'expense' and not is_group and control_type is null order by code limit 1`)[0].id;
    cashB = await account(tenantB, "1111");
    capitalB = await account(tenantB, "3100");
    bank = (await addCashBankAccount(as.owner, { kind: "bank", name: "HBL current account" })).id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("offers only accounts no other form keeps, and leaves expenses out of money out", async () => {
    const ins = await listOtherAccounts(as.accountant, "in");
    const outs = await listOtherAccounts(as.accountant, "out");
    expect(ins.map((a) => a.id)).toEqual(expect.arrayContaining([capital, drawings, loans]));
    expect(ins.map((a) => a.id)).not.toContain(receivables);
    expect(ins.map((a) => a.id)).not.toContain(cash);
    expect(outs.map((a) => a.id)).toEqual(expect.arrayContaining([capital, drawings, loans]));
    expect(outs.some((a) => a.type === "expense")).toBe(false);
  });

  it("records the owner's capital into cash and drawings out of the bank, each with its own number and journal", async () => {
    const key = randomUUID();
    const first = await recordMoneyInOut(as.owner, { ...entry(), clientKey: key });
    expect(first.number).toBe("MI-2627-00001");
    // Sent again from the same form: recorded once.
    expect(await recordMoneyInOut(as.owner, { ...entry(), clientKey: key })).toEqual(first);
    await expect(recordMoneyInOut(as.owner, { ...entry({ amount: "9" }), clientKey: key })).rejects.toThrow("already sent with other figures");
    expect(await journal("MI-2627-00001")).toEqual(["1111 250000 / 0", "3100 0 / 250000"]);

    // The bank needs money in it first: a loan from a director, then drawings out.
    expect((await recordMoneyInOut(as.accountant, entry({ moneyAccountId: bank, otherAccountId: loans, amount: "100000", party: "Director's loan" }))).number).toBe("MI-2627-00002");
    const out = await recordMoneyInOut(as.accountant, entry({ direction: "out", moneyAccountId: bank, otherAccountId: drawings, amount: "15,000.50", party: "Fazal Khan", reference: "CHQ 1234", memo: "For the house" }));
    expect(out.number).toBe("MO-2627-00001");
    const bankCode = (await listCashBankAccounts(as.owner)).find((a) => a.id === bank)!.code;
    expect(await journal("MO-2627-00001")).toEqual(["3200 15000.5 / 0", `${bankCode} 0 / 15000.5`]);
    expect((await listCashBankAccounts(as.owner)).find((a) => a.id === bank)!.balance!.toFixed(2)).toBe("84999.50");

    const shown = (await getMoneyInOut(as.auditor, out.id))!;
    expect([shown.direction, shown.party, shown.reference, shown.memo, shown.status, shown.amount.toFixed(2)]).toEqual(["out", "Fazal Khan", "CHQ 1234", "For the house", "posted", "15000.50"]);
    expect((await listMoneyInOut(as.auditor, "in")).map((r) => r.number)).toEqual(["MI-2627-00002", "MI-2627-00001"]);
    expect((await listMoneyInOut(as.auditor, "out")).map((r) => r.number)).toEqual(["MO-2627-00001"]);

    const audit = await admin<{ action: string; role: string }[]>`
      select action, actor_role as role from public.audit_log where tenant_id = ${tenantA} and entity_id = ${out.id} order by at, id`;
    expect(audit).toEqual([{ action: "money_in_out.record", role: "accountant" }]);
  });

  it("shows in the account's ledger and is matched in bank reconciliation by its number", async () => {
    const ledger = (await getGeneralLedger(as.owner, { from: "2026-11-01", to: "2026-11-30", branchId: null, accountId: drawings }))!;
    expect(JSON.stringify(ledger)).toContain("MO-2627-00001");
    // The bank's statement names the document; the loan comes in on the same day with no reference.
    const statement = "Date,Description,Reference,Debit,Credit\n20/11/2026,Loan received,,,100000.00\n21/11/2026,Cheque paid,MO-2627-00001,15000.50,\n";
    expect(await importStatement(as.accountant, bank, { name: "hbl.csv", text: statement }, "auto")).toEqual({ lines: 2, added: 2, matched: 2 });
    const page = (await getReconciliationPage(as.owner, bank))!;
    expect(page.matches.map((m) => m.rule).sort()).toEqual(["amount_date", "reference"]);
    expect(page.bookLines).toEqual([]);
  });

  it("refuses roles that do not keep the money, a member of one branch, a locked period and the wrong accounts", async () => {
    await expect(recordMoneyInOut(as.auditor, entry())).rejects.toThrow("Only the owner or an accountant");
    await expect(recordMoneyInOut(as.salesperson, entry())).rejects.toThrow("Only the owner or an accountant");
    await expect(recordMoneyInOut(branchAccountant, entry())).rejects.toThrow("every branch");
    // The database refuses them too, whatever the app does.
    expect(await codeOf(as.auditor, record("in", cash, capital))).toBe("42501");
    expect(await codeOf(as.salesperson, record("in", cash, capital))).toBe("42501");
    expect(await codeOf(branchAccountant, record("in", cash, capital))).toBe("42501");
    // A salesperson reads none of it.
    expect(await withTenant(as.salesperson.userId, tenantA, (tx) => tx.execute(sql`select id from public.money_in_out`))).toHaveLength(0);
    // Nobody writes the table, or its audit rows, but the function.
    expect(await codeOf(as.owner, sql`update public.money_in_out set amount = 1`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity) values (${tenantA}, ${userIds.owner}, 'owner', 'money_in_out.record', 'money_in_out')`)).not.toBeUndefined();

    const [november] = await admin<{ id: string }[]>`select id from public.fiscal_periods where tenant_id = ${tenantA} and ${DAY}::date between starts_on and ends_on`;
    await setPeriodLocked(as.owner, november.id, true);
    await expect(recordMoneyInOut(as.owner, entry())).rejects.toThrow(/locked|closed/i);
    expect(await codeOf(as.owner, record("in", cash, capital))).toBe("SE002");
    await setPeriodLocked(as.owner, november.id, false);

    // Another company's accounts, either side.
    expect(await codeOf(as.owner, record("in", cashB, capital))).toBe("SE331");
    expect(await codeOf(as.owner, record("in", cash, capitalB))).toBe("SE381");
    await expect(recordMoneyInOut(as.owner, entry({ otherAccountId: capitalB }))).rejects.toThrow("Choose what the money is from the list");
    // Nor does company B see company A's entries.
    expect(await listMoneyInOut(asB, "in")).toEqual([]);
    // A control account, a cash account as the other side, an expense going out, and a cash account that is not one.
    expect(await codeOf(as.owner, record("in", cash, receivables))).toBe("SE381");
    expect(await codeOf(as.owner, record("in", cash, bank))).toBe("SE381");
    expect(await codeOf(as.owner, record("out", cash, anExpense))).toBe("SE381");
    expect(await codeOf(as.owner, record("in", capital, drawings))).toBe("SE331");
    expect(await codeOf(as.owner, record("sideways", cash, capital))).toBe("SE332");
    expect(await codeOf(as.owner, record("in", cash, capital, "0"))).toBe("SE332");
    expect(await codeOf(as.owner, record("in", cash, capital, "1.005"))).toBe("SE332");
    expect(await codeOf(as.owner, sql`select app.record_money_in_out(${randomUUID()}::uuid, 'in', ${DAY}::date, ${cash}::uuid, ${capital}::uuid, 5::numeric, ' x ', null, null)`)).toBe("SE382");
    expect(await codeOf(as.owner, sql`select app.record_money_in_out(${randomUUID()}::uuid, 'in', '2099-01-01'::date, ${cash}::uuid, ${capital}::uuid, 5::numeric, 'Someone', null, null)`)).toBe("SE333");
  });

  it("is cancelled by a reversal with a reason, once, by the owner or an accountant", async () => {
    const [first] = await listMoneyInOut(as.owner, "out");
    await expect(cancelMoneyInOut(as.auditor, first.id, { date: DAY, reason: "Entered twice" })).rejects.toThrow("Only the owner or an accountant");
    expect(await codeOf(as.auditor, sql`select app.cancel_money_in_out(${first.id}::uuid, ${DAY}::date, 'Entered twice')`)).toBe("42501");
    expect(await codeOf(asB, sql`select app.cancel_money_in_out(${first.id}::uuid, ${DAY}::date, 'Entered twice')`)).toBe("SE334");
    await expect(cancelMoneyInOut(as.owner, first.id, { date: "2026-11-19", reason: "Entered twice" })).rejects.toThrow("That date will not do");
    await expect(cancelMoneyInOut(as.owner, first.id, { date: DAY, reason: "" })).rejects.toThrow("Say why");
    await cancelMoneyInOut(as.owner, first.id, { date: DAY, reason: "Entered twice" });
    const cancelled = (await getMoneyInOut(as.owner, first.id))!;
    expect([cancelled.status, cancelled.cancelReason]).toEqual(["cancelled", "Entered twice"]);
    expect(cancelled.reversal.map((l) => [l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ["0.00", "15000.50"],
      ["15000.50", "0.00"],
    ]);
    await expect(cancelMoneyInOut(as.owner, first.id, { date: DAY, reason: "Again" })).rejects.toThrow("already been cancelled");
    const audit = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity_id = ${first.id} order by at, id`;
    expect(audit.map((a) => a.action)).toEqual(["money_in_out.record", "money_in_out.cancel"]);
  });
});
