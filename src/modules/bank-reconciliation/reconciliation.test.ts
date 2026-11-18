import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { listAccounts } from "@/modules/ledger/queries";
import type { AccountNode } from "@/modules/ledger/rules";
import { openFiscalYear } from "@/modules/numbering/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { postBacked } from "../../../tests/support/journal";
import { deleteStatement, importStatement, matchAutomatically, matchByHand, unmatch } from "./commands";
import { getReconciliationPage } from "./queries";

// Step 35 against a real database, through the app's own path: a bank's statement file imported
// for a bank account and matched with the books; the acceptance (at least 90% of a sample
// statement matched automatically, and the books reconciled equal to the bank); importing again;
// unmatching; and who may do what. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-bank-reconciliation-test";
const tenant = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const cityBranch = randomUUID();
const cityClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@bank.test`, tenantId: tenant, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const cityAccountant = ctx(cityClerk, "accountant", [cityBranch]);
const SAMPLE = readFileSync(new URL("../../../docs/examples/step-35-statement.csv", import.meta.url), "utf8");

let admin: AdminSql;
let chart: AccountNode[];
let bank: string;
const account = (code: string) => chart.find((a) => a.code === code)!.id;
const money = (value: Decimal) => value.toFixed(2);
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "went through";
  } catch (error) {
    return (error as Error).message;
  }
}
async function post(date: string, number: string, debit: string, credit: string, amount: string): Promise<void> {
  await withTenant(userIds.accountant, tenant, (tx) =>
    postBacked(tx, as.accountant, { date, documentNumber: number }, [
      { accountId: debit === "bank" ? bank : account(debit), debit: new Decimal(amount) },
      { accountId: credit === "bank" ? bank : account(credit), credit: new Decimal(amount) },
    ]),
  );
}

describe.skipIf(!hasDb)("bank reconciliation", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${cityBranch}, ${tenant}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenant, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenant, user_id: cityClerk, email: cityAccountant.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
    ])}`;
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    chart = await listAccounts(as.owner);
    bank = (await addAccount(as.owner, { parentId: account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    // November in the books: everything the sample statement shows but its bank charges, and a
    // cheque for repairs the bank has not been shown yet.
    await post("2026-11-02", "JV-2627-90001", "bank", "1111", "50000");
    await post("2026-11-03", "JV-2627-90002", "2150", "bank", "20000");
    await post("2026-11-05", "JV-2627-90003", "bank", "1230", "15000");
    await post("2026-11-08", "JV-2627-90004", "bank", "1230", "7500");
    await post("2026-11-10", "JV-2627-90005", "5230", "bank", "30000");
    await post("2026-11-12", "JV-2627-90006", "bank", "4200", "12345.67");
    await post("2026-11-15", "JV-2627-90007", "2140", "bank", "5000");
    await post("2026-11-20", "JV-2627-90008", "bank", "2510", "100000");
    await post("2026-11-25", "JV-2627-90009", "1520", "bank", "80000");
    await post("2026-11-28", "JV-2627-90010", "5270", "bank", "3000");
  }, 120_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant]);
    await admin.end();
    await closeDb();
  });

  it("acceptance: 90% of a sample statement matches automatically, and the books reconciled equal the bank", async () => {
    const outcome = await importStatement(as.accountant, bank, { name: "hbl-november.csv", text: SAMPLE }, "hbl");
    expect(outcome).toEqual({ lines: 10, added: 10, matched: 9 });
    let page = (await getReconciliationPage(as.auditor, bank))!;
    // Matched by the invoice number the customer wrote, and the rest by amount and day.
    expect(page.matches.map((m) => m.rule).sort()).toEqual([...Array(8).fill("amount_date"), "reference"]);
    expect(page.bankLines.map((l) => [l.description, money(l.amount)])).toEqual([["Bank charges and FED", "-250.00"]]);
    expect(page.bookLines.map((l) => [l.documentNumber, money(l.amount)])).toEqual([["JV-2627-90010", "-3000.00"]]);
    // The bank charges are put in the books, and matched by hand.
    await post("2026-11-30", "JV-2627-90011", "5290", "bank", "250");
    page = (await getReconciliationPage(as.accountant, bank))!;
    const charges = page.bookLines.find((l) => l.documentNumber === "JV-2627-90011")!;
    await matchByHand(as.accountant, bank, [page.bankLines[0].id], [charges.id]);
    page = (await getReconciliationPage(as.owner, bank))!;
    const r = page.reconciliation!;
    expect(r.asAt).toBe("2026-11-29");
    // On the 29th the books hold the charges of the 30th too: matched lines count once both are dated by then.
    const end = (await getReconciliationPage(as.owner, bank, "2026-11-30"))!.reconciliation!;
    expect([end.bankBalance, end.bookBalance, end.unmatchedBooks, end.unmatchedBank, end.adjustedBooks, end.difference].map(money)).toEqual([
      "49595.67",
      "46595.67",
      "-3000.00",
      "0.00",
      "49595.67",
      "0.00",
    ]);
    expect(money(r.difference)).toBe("0.00");
  });

  it("imports a file again without its lines twice, and refuses one with nothing new", async () => {
    expect(await messageOf(importStatement(as.accountant, bank, { name: "again.csv", text: SAMPLE }, "auto"))).toBe("Every line of this file was imported before. Nothing new was added.");
    // December's file repeats November's last line, and adds one.
    const december = `${SAMPLE.split("\n").slice(0, 5).join("\n")}\n29-Nov-2026,29-Nov-2026,Bank charges and FED,,250.00,,"49,595.67"\n01-Dec-2026,01-Dec-2026,Cash deposit,,,"1,000.00","50,595.67"\n`;
    expect(await importStatement(as.owner, bank, { name: "hbl-december.csv", text: december }, "hbl")).toEqual({ lines: 2, added: 1, matched: 0 });
    const page = (await getReconciliationPage(as.owner, bank))!;
    expect(page.statements.map((s) => [s.fileName, s.lines, s.added])).toEqual([
      ["hbl-november.csv", 10, 10],
      ["hbl-december.csv", 2, 1],
    ]);
    // A file it cannot read comes back with its problems, and nothing is imported.
    expect(await importStatement(as.owner, bank, { name: "bad.csv", text: "Date,Description,Debit,Credit\n32/11/2026,X,100,\n" }, "auto")).toEqual({ problems: ['Row 2: "32/11/2026" is not a day.'] });
  });

  it("unmatches, refuses lines that do not add up, and removes only an import with nothing matched", async () => {
    let page = (await getReconciliationPage(as.owner, bank))!;
    const loan = page.matches.find((m) => m.books.some((b) => b.number === "JV-2627-90008"))!;
    await unmatch(as.accountant, loan.id);
    page = (await getReconciliationPage(as.owner, bank))!;
    const loanBank = page.bankLines.find((l) => l.description === "Loan disbursement")!;
    const loanBook = page.bookLines.find((l) => l.documentNumber === "JV-2627-90008")!;
    const deposit = page.bankLines.find((l) => l.date === "2026-12-01")!;
    expect(await messageOf(matchByHand(as.accountant, bank, [loanBank.id, deposit.id], [loanBook.id]))).toMatch(/do not add up to the same money/);
    expect(await matchAutomatically(as.accountant, bank)).toEqual({ matched: 1 });
    // December's import holds one line that is November's (matched): it is the November file that cannot go.
    const november = page.statements.find((s) => s.fileName === "hbl-november.csv")!;
    const december = page.statements.find((s) => s.fileName === "hbl-december.csv")!;
    expect(await messageOf(deleteStatement(as.owner, november.id))).toBe("Some of this statement's lines are matched. Unmatch them first.");
    await deleteStatement(as.owner, december.id);
    expect((await getReconciliationPage(as.owner, bank))!.statements.map((s) => s.fileName)).toEqual(["hbl-november.csv"]);
    // Two later files sharing a day: the earlier is not removed while the later stands (it holds no copy of the shared day).
    const head = SAMPLE.split("\n").slice(0, 5).join("\n");
    await importStatement(as.owner, bank, { name: "early.csv", text: `${head}\n02-Dec-2026,02-Dec-2026,Deposit,,,"100.00","49,695.67"\n03-Dec-2026,03-Dec-2026,Deposit,,,"200.00","49,895.67"\n` }, "hbl");
    await importStatement(as.owner, bank, { name: "late.csv", text: `${head}\n03-Dec-2026,03-Dec-2026,Deposit,,,"200.00","49,895.67"\n04-Dec-2026,04-Dec-2026,Deposit,,,"300.00","50,195.67"\n` }, "hbl");
    const files = (await getReconciliationPage(as.owner, bank))!.statements;
    const early = files.find((f) => f.fileName === "early.csv")!;
    const late = files.find((f) => f.fileName === "late.csv")!;
    expect(await messageOf(deleteStatement(as.owner, early.id))).toBe("A statement imported after this one shares days with it. Remove that one first.");
    await deleteStatement(as.owner, late.id);
    await deleteStatement(as.owner, early.id);
    expect((await getReconciliationPage(as.owner, bank))!.statements.map((s) => s.fileName)).toEqual(["hbl-november.csv"]);
    const [audit] = await admin<{ n: number }[]>`select count(*)::int as n from public.audit_log where tenant_id = ${tenant} and action like 'bank_%'`;
    expect(audit.n).toBeGreaterThanOrEqual(14);
  });

  it("is kept by the owner and an accountant who work everywhere, read by the auditor, and hidden from everyone else", async () => {
    expect(await messageOf(importStatement(as.auditor, bank, { name: "x.csv", text: SAMPLE }, "hbl"))).toBe("A bank account is reconciled by the owner or an accountant.");
    expect(await messageOf(importStatement(cityAccountant, bank, { name: "x.csv", text: SAMPLE }, "hbl"))).toBe("A bank account is reconciled by someone who works across the whole company.");
    await expect(getReconciliationPage(as.salesperson, bank)).rejects.toThrow("Your role does not include cash and bank.");
    const [seen] = await withTenant(userIds.salesperson, tenant, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from public.bank_statement_lines`));
    expect(seen.n).toBe(0);
    // Straight at the database: nobody writes a statement line but the database's own functions.
    const code = await withTenant(userIds.owner, tenant, (tx) => tx.execute(sql`update public.bank_statement_lines set amount = 1`)).then(
      () => "went through",
      (error: { cause?: { code?: string }; code?: string }) => error.cause?.code ?? error.code,
    );
    expect(code).toBe("42501");
  });
});
