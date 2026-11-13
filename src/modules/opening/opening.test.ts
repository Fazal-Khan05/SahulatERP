import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { postJournal, reverseJournal } from "@/modules/ledger/posting";
import { getJournal, listAccounts } from "@/modules/ledger/queries";
import type { AccountNode } from "@/modules/ledger/rules";
import { openFiscalYear } from "@/modules/numbering/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addOpenDocument, discardOpening, importOpeningLines, postOpening, removeOpeningLine, reverseOpening, setAccountBalance, setOpeningDate, startOpening } from "./commands";
import { ageOpening, getOpening } from "./queries";
import { openingBalances, openingEntries } from "./schema";

// Opening balances against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-opening-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const scopedAccountant = randomUUID();
const ownerB = randomUUID();
const branch = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@opening.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const scoped = ctx(scopedAccountant, tenantA, "accountant", [branch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const OPENING = "2026-07-01";
const customer = { alpha: randomUUID(), beta: randomUUID(), gamma: randomUUID(), delta: randomUUID() };
const supplier = { sigma: randomUUID(), tau: randomUUID() };

let admin: AdminSql;
let chart: AccountNode[];
let bank: string;
const account = (code: string) => chart.find((a) => a.code === code)!.id;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
/** Opens the year before the first one, so that a date before the opening date has a period to fall in. */
const openFiscalYearBefore = () =>
  admin`insert into public.fiscal_periods (tenant_id, year_start, period_no, starts_on, ends_on, created_by)
    select ${tenantA}, '2025-07-01', n, ('2025-07-01'::date + (n - 1) * interval '1 month')::date, ('2025-07-01'::date + n * interval '1 month' - interval '1 day')::date, ${userIds.owner}
    from generate_series(1, 12) n`;
const lineIds = async (filter: (line: NonNullable<Awaited<ReturnType<typeof getOpening>>>["lines"][number]) => boolean) => ((await getOpening(as.owner))?.lines ?? []).filter(filter).map((line) => line.id);

describe.skipIf(!hasDb)("opening balances", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: scopedAccountant, email: scoped.email, role: "accountant", branch_ids: [branch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    const party = (id: string, code: string | null, name: string) => ({ id, tenant_id: tenantA, code, name, created_by: userIds.owner, updated_by: userIds.owner });
    await admin`insert into public.customers ${admin([party(customer.alpha, "C-001", "Alpha Motors"), party(customer.beta, null, "Beta"), party(customer.gamma, "BETA", "Gamma Autos"), party(customer.delta, null, "Delta Stores")])}`;
    await admin`insert into public.suppliers ${admin([party(supplier.sigma, "S-001", "Sigma Imports"), party(supplier.tau, null, "Tau Parts")])}`;
    await seedAccounts(as.owner, "trading");
    await seedAccounts(otherOwner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    chart = await listAccounts(as.owner);
    bank = (await addAccount(as.owner, { parentId: account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    chart = await listAccounts(as.owner);
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("starts one opening entry per company, by someone who keeps the books for the whole company", async () => {
    expect(await getOpening(as.auditor)).toBeNull();
    for (const role of ["auditor", "salesperson"] as const) await expect(startOpening(as[role], { date: OPENING }), role).rejects.toThrow("Only an owner or an accountant can enter opening balances.");
    await expect(startOpening(scoped, { date: OPENING })).rejects.toThrow("Opening balances belong to the whole company.");
    await expect(startOpening(as.owner, { date: "01-07-2026" })).rejects.toThrow("Enter the opening date.");
    const both = await Promise.allSettled([startOpening(as.owner, { date: OPENING }), startOpening(as.accountant, { date: OPENING })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("This company already has opening balances in draft. Carry on with them, or discard them to start again.");
    expect(await getOpening(as.auditor)).toMatchObject({ status: "draft", openingDate: OPENING, lines: [] });
    await expect(getOpening(as.salesperson)).rejects.toThrow("Only an owner, an accountant or an auditor can see the opening balances.");
    await expect(postOpening(as.owner)).rejects.toThrow("Add at least one balance before posting.");
  });

  it("takes account balances one at a time, and corrects one saved again", async () => {
    await setAccountBalance(as.accountant, { accountId: account("1111"), debit: "50000", credit: "" });
    await setAccountBalance(as.accountant, { accountId: bank, debit: "450000", credit: "" });
    await setAccountBalance(as.owner, { accountId: account("3100"), debit: "", credit: "2000000" });
    await setAccountBalance(as.owner, { accountId: account("3100"), debit: "", credit: "2226460" });
    const entry = await getOpening(as.auditor);
    expect(entry?.lines.map((l) => `${l.code} ${l.name} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["1111 Cash in hand 50000.00 0.00", "1121 HBL current account 450000.00 0.00", "3100 Owner's capital 0.00 2226460.00"]);
    // Accounts whose balance is made up of other records are refused, each with its reason.
    await expect(setAccountBalance(as.owner, { accountId: account("1200"), debit: "5" })).rejects.toThrow("1200 Trade receivables is entered customer by customer, invoice by invoice, under Receivables.");
    await expect(setAccountBalance(as.owner, { accountId: account("2110"), credit: "5" })).rejects.toThrow("2110 Trade payables is entered supplier by supplier");
    await expect(setAccountBalance(as.owner, { accountId: account("1300"), debit: "5" })).rejects.toThrow("1300 Stock in trade is brought in item by item when stock is set up, not here.");
    await expect(setAccountBalance(as.owner, { accountId: account("3900"), credit: "5" })).rejects.toThrow("3900 Opening balance equity is the balancing account");
    await expect(setAccountBalance(as.owner, { accountId: account("1100"), debit: "5" })).rejects.toThrow("1100 Current assets is a heading. Choose one of the accounts under it.");
    await expect(setAccountBalance(as.owner, { accountId: randomUUID(), debit: "5" })).rejects.toThrow("That account is not in this company.");
    await expect(setAccountBalance(as.owner, { accountId: account("1111"), debit: "5", credit: "5" })).rejects.toThrow("Enter a debit or a credit, not both");
    await expect(setAccountBalance(as.auditor, { accountId: account("1111"), debit: "5" })).rejects.toThrow("Only an owner or an accountant can enter opening balances.");
    const [audited] = await admin`select before, after from public.audit_log where tenant_id = ${tenantA} and action = 'opening.set_account' and before is not null`;
    expect(audited).toEqual({ before: { account: "3100", debit: "0.0000", credit: "2000000.0000" }, after: { account: "3100", debit: "0.0000", credit: "2226460.0000" } });
  });

  it("takes unpaid invoices and bills, by the party's code or name, each once", async () => {
    await addOpenDocument(as.accountant, "receivable", { party: "c-001", documentNumber: "SI-0412", documentDate: "05-03-2026", dueDate: "04-04-2026", amount: "84500" });
    // "Beta" is one customer's name and another's code: the code wins.
    await addOpenDocument(as.accountant, "receivable", { party: "Beta", documentNumber: "SI-0500", documentDate: "2026-06-25", amount: "10" });
    await addOpenDocument(as.owner, "payable", { party: "Tau Parts", documentNumber: "B-77", documentDate: "2026-06-01", dueDate: "", amount: "36010.75" });
    await expect(addOpenDocument(as.owner, "receivable", { party: "C-001", documentNumber: "si-0412", documentDate: "2026-03-05", amount: "1" })).rejects.toThrow("This customer already has an invoice with that number here.");
    await expect(addOpenDocument(as.owner, "payable", { party: "tau parts", documentNumber: "b-77", documentDate: "2026-06-01", amount: "1" })).rejects.toThrow("This supplier already has a bill with that number here.");
    await expect(addOpenDocument(as.owner, "receivable", { party: "Nobody", documentNumber: "X", documentDate: "2026-03-05", amount: "1" })).rejects.toThrow("No customer has that code or name.");
    await expect(addOpenDocument(as.owner, "receivable", { party: "S-001", documentNumber: "X", documentDate: "2026-03-05", amount: "1" })).rejects.toThrow("No customer has that code or name.");
    await expect(addOpenDocument(as.owner, "receivable", { party: "C-001", documentNumber: "X", documentDate: OPENING, amount: "1" })).rejects.toThrow("The invoice's date must be before the opening date.");
    await expect(addOpenDocument(as.owner, "receivable", { party: "", documentNumber: "X", documentDate: "2026-03-05", amount: "1" })).rejects.toThrow("Enter the customer's code or name.");
    const entry = await getOpening(as.owner);
    expect(entry?.lines.filter((l) => l.kind !== "account").map((l) => `${l.kind} ${l.name} ${l.documentNumber} ${l.documentDate} ${l.dueDate} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual([
      "payable Tau Parts B-77 2026-06-01 null 0.00 36010.75",
      "receivable Alpha Motors SI-0412 2026-03-05 2026-04-04 84500.00 0.00",
      "receivable Gamma Autos SI-0500 2026-06-25 null 10.00 0.00",
    ]);
    // The opening date cannot move to before an invoice already entered.
    await expect(setOpeningDate(as.owner, { date: "2026-06-20" })).rejects.toThrow("Gamma Autos's invoice SI-0500 is dated on or after that day.");
    // A line is removed; a page that still shows it is told it has gone.
    const [gamma] = await lineIds((l) => l.documentNumber === "SI-0500");
    await removeOpeningLine(as.accountant, gamma);
    await expect(removeOpeningLine(as.accountant, gamma)).rejects.toThrow("That line is no longer on the opening entry. Reload the page.");
    expect(await lineIds((l) => l.documentNumber === "SI-0500")).toEqual([]);
  });

  it("imports a file all or nothing, listing every bad row", async () => {
    const bad = await importOpeningLines(as.accountant, "receivable", { name: "ar.csv", text: "Customer,Invoice number,Invoice date,Due date,Amount unpaid\nC-001,SI-0412,05-03-2026,,1\nDelta Stores,SI-0601,20-06-2026,,1500.75\nNobody,SI-1,01-06-2026,,5\nC-001,SI-0700,01-07-2026,,5\n" });
    expect(bad).toEqual({
      problems: [
        { row: 2, name: "Alpha Motors SI-0412", problems: ["This invoice of this customer is already here."] },
        { row: 4, name: "Nobody SI-1", problems: ['No customer has the code or name "Nobody". Add the customer first, or correct it.'] },
        { row: 5, name: "C-001 SI-0700", problems: ["The invoice's date must be before the opening date. One dated on or after it is entered as an ordinary invoice."] },
      ],
    });
    // Nothing of that file was kept, the good row included.
    expect(await lineIds((l) => l.documentNumber === "SI-0601")).toEqual([]);
    expect(await importOpeningLines(as.accountant, "receivable", { name: "ar.csv", text: "Customer,Invoice number,Invoice date,Due date,Amount unpaid\nDelta Stores,SI-0601,20-06-2026,,1500.75\nAlpha Motors,SI-0455,15/05/2026,14/06/2026,200\nGamma Autos,SI-0490,20-04-2026,,40\n" })).toEqual({ imported: 3 });
    expect(await importOpeningLines(as.owner, "payable", { name: "ap.csv", text: "Supplier,Bill number,Bill date,Amount unpaid\nS-001,B-1,2026-06-10,12000\n" })).toEqual({ imported: 1 });
    // Dates that could be day first or month first are not guessed at.
    await expect(importOpeningLines(as.owner, "payable", { name: "ap.csv", text: "Supplier,Bill number,Bill date,Amount unpaid\nS-001,B-2,10-06-2026,5\n" })).rejects.toThrow("The dates in this file could be day first or month first");

    const tb = await importOpeningLines(as.owner, "account", { name: "tb.csv", text: "Account code,Account name,Debit,Credit\n1111,Cash in hand,50000,\n1510,Furniture and fixtures,125000,\n5230,Rent,0,0\n1200,Trade receivables,86210.75,\n2510,Loans from banks,,200000\n9999,Unknown,1,\n" });
    expect(tb).toEqual({
      problems: [
        { row: 2, name: "1111 Cash in hand", problems: ["This account already has an opening balance here. Remove that line first, or leave this row out."] },
        { row: 5, name: "1200 Trade receivables", problems: ["1200 Trade receivables is entered customer by customer, invoice by invoice, under Receivables. Its total is worked out from those."] },
        { row: 7, name: "9999 Unknown", problems: ["No account has the code 9999. Add it under Settings, Accounts, or correct the code."] },
      ],
    });
    expect(await importOpeningLines(as.owner, "account", { name: "tb.csv", text: "Account code,Account name,Debit,Credit\n1510,Furniture and fixtures,125000,\n5230,Rent,0,0\n2510,Loans from banks,,200000\n" })).toEqual({ imported: 2 });
    await expect(importOpeningLines(as.owner, "account", { name: "tb.csv", text: "Code,Amount\n1111,5\n" })).rejects.toThrow('The column "Amount" is not one this import knows.');
    await expect(importOpeningLines(as.auditor, "account", { name: "tb.csv", text: "x" })).rejects.toThrow("Only an owner or an accountant can enter opening balances.");
    const audited = await admin`select action, after from public.audit_log where tenant_id = ${tenantA} and action like 'opening.import%' order by at`;
    expect(audited.map((a) => `${a.action} ${a.after.rows} ${a.after.file}`)).toEqual(["opening.import_receivable 3 ar.csv", "opening.import_payable 1 ap.csv", "opening.import_account 2 tb.csv"]);
  });

  it("posts one journal that balances through opening balance equity", async () => {
    await expect(postOpening(as.auditor)).rejects.toThrow("Only an owner or an accountant can enter opening balances.");
    const before = await getOpening(as.owner);
    // A page opened before someone else's change cannot post what it no longer shows.
    await setAccountBalance(as.accountant, { accountId: account("1530"), debit: "1100000", credit: "" });
    await expect(postOpening(as.owner, before!.updatedAt.toISOString())).rejects.toThrow("The opening balances were changed after you opened this page.");
    expect(await postOpening(as.owner, (await getOpening(as.owner))!.updatedAt.toISOString())).toEqual({ difference: "-663230.0000" });

    const entry = (await getOpening(as.auditor))!;
    expect(entry.status).toBe("posted");
    const journal = await getJournal(as.auditor, entry.journalId!);
    expect(journal).toMatchObject({ date: OPENING, sourceType: "opening_balance", sourceId: entry.id, memo: "Opening balances", documentNumber: null, branchId: null });
    const party = (id: string | null) => Object.entries({ ...customer, ...supplier }).find(([, value]) => value === id)?.[0] ?? "-";
    expect(journal?.lines.map((l) => `${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)} ${party(l.customerId ?? l.supplierId)}`).sort()).toEqual(
      [
        "1111 50000.00 0.00 -",
        "1121 450000.00 0.00 -",
        "1510 125000.00 0.00 -",
        "1530 1100000.00 0.00 -",
        "2510 0.00 200000.00 -",
        "3100 0.00 2226460.00 -",
        // Receivables once per customer: Alpha 84,500 + 200, Delta 1,500.75, Gamma 40.
        "1200 84700.00 0.00 alpha",
        "1200 1500.75 0.00 delta",
        "1200 40.00 0.00 gamma",
        // Payables once per supplier.
        "2110 0.00 12000.00 sigma",
        "2110 0.00 36010.75 tau",
        // Debits 1,811,240.75, credits 2,474,470.75: equity is debited with the 663,230.00 between
        // them, which is the stock these books hold and this journal leaves out.
        "3900 663230.00 0.00 -",
      ].sort(),
    );
    const [totals] = await admin`select sum(debit)::text as debit, sum(credit)::text as credit from public.journal_lines where tenant_id = ${tenantA} and journal_id = ${entry.journalId}`;
    expect(totals).toEqual({ debit: "2474470.7500", credit: "2474470.7500" });
    // Each customer's balance in the ledger is the sum of their unpaid invoices.
    const owed = await admin`select c.name, sum(l.debit - l.credit)::text as owed from public.journal_lines l join public.customers c on c.id = l.customer_id where l.tenant_id = ${tenantA} group by c.name order by c.name`;
    expect(owed.map((o) => `${o.name} ${o.owed}`)).toEqual(["Alpha Motors 84700.0000", "Delta Stores 1500.7500", "Gamma Autos 40.0000"]);

    // Posted, nothing about it changes.
    await expect(setAccountBalance(as.owner, { accountId: account("1111"), debit: "1" })).rejects.toThrow("The opening balances are posted and cannot be changed. Reverse them to correct them.");
    await expect(addOpenDocument(as.owner, "receivable", { party: "C-001", documentNumber: "Z", documentDate: "2026-06-01", amount: "1" })).rejects.toThrow("posted and cannot be changed");
    await expect(removeOpeningLine(as.owner, entry.lines[0].id)).rejects.toThrow("posted and cannot be changed");
    await expect(discardOpening(as.owner)).rejects.toThrow("posted and cannot be changed");
    await expect(postOpening(as.owner)).rejects.toThrow("posted and cannot be changed");
    await expect(startOpening(as.owner, { date: OPENING })).rejects.toThrow("This company's opening balances are already posted. Reverse them to correct them.");
    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'opening.post'`;
    expect(audited).toMatchObject({ actor_role: "owner", after: { openingDate: OPENING, lines: 12, journalLines: 12, toOpeningEquity: "-663230.0000" } });
  });

  it("ages imported receivables from each invoice's own date, not from the day they were entered", async () => {
    const entry = (await getOpening(as.auditor))!;
    const show = (kind: "receivable" | "payable", asOf: string) => {
      const aged = ageOpening(entry, kind, asOf);
      return [...aged.parties.map((p) => [p.partyName, ...p.bands.map((b) => b.toFixed(2)), p.total.toFixed(2)]), ["Total", ...aged.bands.map((b) => b.toFixed(2)), aged.total.toFixed(2)]];
    };
    // On the opening date: 5 March is 118 days old, 15 May 47, 20 June 11, 20 April 72.
    expect(show("receivable", "2026-07-01")).toEqual([
      ["Alpha Motors", "0.00", "200.00", "0.00", "84500.00", "84700.00"],
      ["Delta Stores", "1500.75", "0.00", "0.00", "0.00", "1500.75"],
      ["Gamma Autos", "0.00", "0.00", "40.00", "0.00", "40.00"],
      ["Total", "1500.75", "200.00", "40.00", "84500.00", "86240.75"],
    ]);
    // Six weeks on, every invoice is six weeks older.
    expect(show("receivable", "2026-08-12")).toEqual([
      ["Alpha Motors", "0.00", "0.00", "200.00", "84500.00", "84700.00"],
      ["Delta Stores", "0.00", "1500.75", "0.00", "0.00", "1500.75"],
      ["Gamma Autos", "0.00", "0.00", "0.00", "40.00", "40.00"],
      ["Total", "0.00", "1500.75", "200.00", "84540.00", "86240.75"],
    ]);
    expect(show("payable", "2026-07-01")).toEqual([
      ["Sigma Imports", "12000.00", "0.00", "0.00", "0.00", "12000.00"],
      ["Tau Parts", "36010.75", "0.00", "0.00", "0.00", "36010.75"],
      ["Total", "48010.75", "0.00", "0.00", "0.00", "48010.75"],
    ]);
    // What is aged is exactly what the ledger holds on trade receivables.
    const [ledger] = await admin`select sum(l.debit - l.credit)::text as owed from public.journal_lines l where l.tenant_id = ${tenantA} and l.account_id = ${account("1200")}`;
    expect(new Decimal(ledger.owed).toFixed(2)).toBe(ageOpening(entry, "receivable", "2026-07-01").total.toFixed(2));
  });

  it("is corrected by reversing: both journals stay, and the same lines come back as a draft", async () => {
    const posted = (await getOpening(as.owner))!;
    await expect(reverseOpening(as.auditor)).rejects.toThrow("Only an owner or an accountant can enter opening balances.");
    // A page opened before someone else's change cannot reverse what it no longer shows.
    await expect(reverseOpening(as.owner, new Date(0).toISOString())).rejects.toThrow("The opening balances were changed after you opened this page.");
    await reverseOpening(as.accountant);
    const draft = (await getOpening(as.owner))!;
    expect(draft).toMatchObject({ status: "draft", openingDate: OPENING, journalId: null });
    expect(draft.id).not.toBe(posted.id);
    expect(draft.lines.map((l) => `${l.kind} ${l.name} ${l.documentNumber} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(posted.lines.map((l) => `${l.kind} ${l.name} ${l.documentNumber} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`));
    // The two journals cancel out, account by account and customer by customer.
    const left = await admin`select account_id from public.journal_lines where tenant_id = ${tenantA} group by account_id, customer_id, supplier_id having sum(debit) <> sum(credit)`;
    expect(left).toHaveLength(0);
    const [reversed] = await admin`select status, reversal_journal_id is not null as has_reversal from public.opening_entries where id = ${posted.id}`;
    expect(reversed).toEqual({ status: "reversed", has_reversal: true });
    await expect(reverseOpening(as.owner)).rejects.toThrow("The opening balances are still a draft.");
    // The reversal is dated on the opening date itself, so no date ever shows the balances twice:
    // on every day from the opening date on, the two journals already cancel out.
    const [reversal] = await admin`select journal_date::text as date, memo from public.journals where tenant_id = ${tenantA} and source_type = 'reversal'`;
    expect(reversal).toEqual({ date: OPENING, memo: "Reversal of the opening balances" });

    // Corrected and posted again: the furniture was 150,000, not 125,000.
    const [furniture] = await lineIds((l) => l.code === "1510");
    await removeOpeningLine(as.owner, furniture);
    await setAccountBalance(as.owner, { accountId: account("1510"), debit: "150000", credit: "" });
    expect(await postOpening(as.owner)).toEqual({ difference: "-638230.0000" });
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n).toBe(3);
    // As at any date, the books now hold the corrected balances once.
    const asAt = await admin`
      select a.code, sum(l.debit - l.credit)::text as net
      from public.journal_lines l
      join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${tenantA} and j.journal_date <= ${OPENING} and a.code in ('1111', '1200', '1510', '3900')
      group by a.code order by a.code`;
    expect(asAt.map((r) => `${r.code} ${r.net}`)).toEqual(["1111 50000.0000", "1200 86240.7500", "1510 150000.0000", "3900 638230.0000"]);
  });

  it("needs an open fiscal period on the opening date", async () => {
    // The other company has no fiscal year yet.
    await startOpening(otherOwner, { date: "2026-07-01" });
    const theirs = await listAccounts(otherOwner);
    await setAccountBalance(otherOwner, { accountId: theirs.find((a) => a.code === "1111")!.id, debit: "100", credit: "" });
    await expect(postOpening(otherOwner)).rejects.toThrow("No fiscal period is open for 01-07-2026. An owner opens the fiscal year under Settings, Fiscal periods.");
    expect(await getOpening(otherOwner)).toMatchObject({ status: "draft" });
    await setOpeningDate(otherOwner, { date: "2026-08-01" });
    expect((await getOpening(otherOwner))?.openingDate).toBe("2026-08-01");
    await discardOpening(otherOwner);
    expect(await getOpening(otherOwner)).toBeNull();
  });

  it("lets nothing into the books from before the opening date", async () => {
    // Once the opening balances are posted, a journal dated before them is refused.
    const rent = [{ accountId: account("5230"), debit: new Decimal("10") }, { accountId: account("1111"), credit: new Decimal("10") }];
    await admin`update public.fiscal_periods set locked_at = null where tenant_id = ${tenantA}`;
    await openFiscalYearBefore();
    await expect(withTenant(userIds.accountant, tenantA, (tx) => postJournal(tx, { type: "manual_journal", id: randomUUID(), date: "2026-06-30" }, rent))).rejects.toThrow("That date is before the day the books were opened here.");
    await withTenant(userIds.accountant, tenantA, (tx) => postJournal(tx, { type: "manual_journal", id: randomUUID(), date: OPENING }, rent));
    // And opening balances cannot be dated after journals already in the books (the other company).
    const theirs = await listAccounts(otherOwner);
    const of = (code: string) => theirs.find((a) => a.code === code)!.id;
    await openFiscalYear(otherOwner, { month: "7", year: "2026" });
    await withTenant(ownerB, tenantB, (tx) => postJournal(tx, { type: "manual_journal", id: randomUUID(), date: "2026-07-10" }, [{ accountId: of("5230"), debit: new Decimal("10") }, { accountId: of("1111"), credit: new Decimal("10") }]));
    await startOpening(otherOwner, { date: "2026-08-01" });
    await setAccountBalance(otherOwner, { accountId: of("1111"), debit: "100", credit: "" });
    await expect(postOpening(otherOwner)).rejects.toThrow("The books already hold journals dated before 01-08-2026.");
    await setOpeningDate(otherOwner, { date: "2026-07-10" });
    expect(await postOpening(otherOwner)).toEqual({ difference: "100.0000" });
    await reverseOpening(otherOwner);
    await discardOpening(otherOwner);
  });

  it("keeps the same rules in the database, whatever the app does", async () => {
    const posted = (await getOpening(as.owner))!;
    const mine = (id: string) => and(eq(openingEntries.tenantId, tenantA), eq(openingEntries.id, id));
    const set = (who: string, id: string, change: Record<string, unknown>) => codeOf(() => withTenant(who, tenantA, (tx) => tx.update(openingEntries).set({ updatedBy: who, ...change }).where(mine(id))));
    // Posted balances cannot be edited, re-dated, sent back to draft, deleted, or have a line touched.
    for (const change of [{ openingDate: "2026-07-02" }, { status: "draft", journalId: null, postedAt: null, postedBy: null }, { status: "reversed", reversalJournalId: posted.journalId, reversedAt: new Date(), reversedBy: userIds.owner }]) {
      expect(["SE041", "SE043"], JSON.stringify(change)).toContain(await set(userIds.owner, posted.id, change));
    }
    expect(await withTenant(userIds.owner, tenantA, (tx) => tx.delete(openingEntries).where(mine(posted.id)).returning({ id: openingEntries.id }))).toEqual([]);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.delete(openingBalances).where(eq(openingBalances.openingEntryId, posted.id))))).toBe("SE041");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(openingBalances).values({ tenantId: tenantA, openingEntryId: posted.id, kind: "account", accountId: account("5230"), debit: "1", createdBy: userIds.owner })))).toBe("SE041");

    // A draft in the other company: it cannot be marked posted without the engine's journal for
    // it, nor with a journal that says something other than its lines.
    const { id: draftId } = await startOpening(otherOwner, { date: "2026-07-01" });
    const theirs = await listAccounts(otherOwner);
    const of = (code: string) => theirs.find((a) => a.code === code)!.id;
    await setAccountBalance(otherOwner, { accountId: of("1111"), debit: "100", credit: "" });
    const [theirCustomerA, theirCustomerB] = await admin<{ id: string }[]>`insert into public.customers (tenant_id, name, created_by, updated_by) values (${tenantB}, 'First customer', ${ownerB}, ${ownerB}), (${tenantB}, 'Second customer', ${ownerB}, ${ownerB}) returning id`;
    await addOpenDocument(otherOwner, "receivable", { party: "First customer", documentNumber: "A-1", documentDate: "2026-06-01", amount: "40" });
    const theirEntry = and(eq(openingEntries.tenantId, tenantB), eq(openingEntries.id, draftId));
    // A statement cannot change which company it is in half-way, to slip a row past these rules.
    expect(
      await codeOf(() =>
        withTenant(ownerB, tenantB, (tx) =>
          tx.execute(sql`insert into public.opening_balances (tenant_id, opening_entry_id, kind, account_id, debit, created_by)
            select ${tenantB}, ${draftId}::uuid, 'account', v.account, case when v.n = 2 and set_config('app.tenant_id', '', true) = '' then 1 else 1 end, ${ownerB}
            from (values (${of("5230")}::uuid, 1), (${of("5240")}::uuid, 2)) as v(account, n)`),
        ),
      ),
    ).toBe(DENIED);
    expect((await getOpening(otherOwner))?.lines).toHaveLength(2);
    const forge = (lines: { accountId: string; debit?: Decimal; credit?: Decimal; customerId?: string }[] | null, postedBy: string = ownerB) =>
      codeOf(() =>
        withTenant(ownerB, tenantB, async (tx) => {
          const journalId = lines ? await postJournal(tx, { type: "opening_balance", id: draftId, date: "2026-07-01" }, lines) : randomUUID();
          await tx.update(openingEntries).set({ status: "posted", journalId, postedAt: new Date(), postedBy, updatedBy: ownerB }).where(theirEntry);
        }),
      );
    const cash = { accountId: of("1111"), debit: new Decimal("100") };
    const owed = (customerId: string, amount = "40") => ({ accountId: of("1200"), debit: new Decimal(amount), customerId });
    const equity = (amount: string) => ({ accountId: of("3900"), credit: new Decimal(amount) });
    expect(await forge(null)).toBe("SE043");
    expect(await forge([{ accountId: of("1111"), debit: new Decimal("999") }, owed(theirCustomerA.id), equity("1039")])).toBe("SE043");
    expect(await forge([cash, owed(theirCustomerA.id), { accountId: of("5230"), debit: new Decimal("5") }, equity("145")])).toBe("SE043");
    // What one customer owes cannot be posted to another, nor left out, even though the totals agree.
    expect(await forge([cash, owed(theirCustomerB.id), equity("140")])).toBe("SE043");
    expect(await forge([cash, { accountId: of("1230"), debit: new Decimal("40") }, equity("140")])).toBe("SE043");
    // Nor under someone else's name.
    expect(await forge([cash, owed(theirCustomerA.id), equity("140")], userIds.owner)).toBe(DENIED);
    // An invoice dated on or after the opening date, slipped in past the app, stops the posting.
    await withTenant(ownerB, tenantB, (tx) => tx.insert(openingBalances).values({ tenantId: tenantB, openingEntryId: draftId, kind: "receivable", customerId: theirCustomerB.id, documentNumber: "LATE", documentDate: "2030-01-01", debit: "1", createdBy: ownerB }));
    expect(await forge([cash, owed(theirCustomerA.id), owed(theirCustomerB.id, "1"), equity("141")])).toBe("SE043");
    await removeOpeningLine(otherOwner, (await getOpening(otherOwner))!.lines.find((l) => l.documentNumber === "LATE")!.id);
    // The journal that says exactly what the lines say is accepted.
    expect(await forge([cash, owed(theirCustomerA.id), equity("140")])).toBeUndefined();
    // And it is reversed only on the opening date itself, by the engine's own reversal.
    const postedTheirs = (await getOpening(otherOwner))!;
    expect(
      await codeOf(() =>
        withTenant(ownerB, tenantB, async (tx) => {
          const reversalJournalId = await reverseJournal(tx, postedTheirs.journalId!, { date: "2026-07-05" });
          await tx.update(openingEntries).set({ status: "reversed", reversalJournalId, reversedAt: new Date(), reversedBy: ownerB, updatedBy: ownerB }).where(theirEntry);
        }),
      ),
    ).toBe("SE043");

    // The times on a row are the database's own.
    const [stamps] = await admin`select bool_and(created_at > now() - interval '1 hour') as fresh from public.opening_entries where tenant_id in (${tenantA}, ${tenantB})`;
    expect(stamps.fresh).toBe(true);

    // Who may read and write.
    const row = { tenantId: tenantA, openingDate: OPENING, createdBy: userIds.auditor, updatedBy: userIds.auditor };
    expect(await codeOf(() => withTenant(userIds.auditor, tenantA, (tx) => tx.insert(openingEntries).values(row)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(scopedAccountant, tenantA, (tx) => tx.insert(openingEntries).values({ ...row, createdBy: scopedAccountant, updatedBy: scopedAccountant })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(openingEntries).values({ ...row, createdBy: userIds.owner, updatedBy: userIds.owner })))).toBe("23505");
    expect(await withTenant(scopedAccountant, tenantA, (tx) => tx.select().from(openingEntries))).toEqual([]);
    expect(await withTenant(scopedAccountant, tenantA, (tx) => tx.select().from(openingBalances))).toEqual([]);
    expect(await withTenant(userIds.salesperson, tenantA, (tx) => tx.select().from(openingBalances))).toEqual([]);
    expect(await withTenant(ownerB, tenantA, (tx) => tx.select().from(openingEntries))).toEqual([]);
    expect((await withTenant(userIds.auditor, tenantA, (tx) => tx.select().from(openingEntries))).length).toBe(2);
    // A line is a whole line of its kind.
    const line = (values: Record<string, unknown>) => codeOf(() => withTenant(ownerB, tenantB, (tx) => tx.execute(sql`select 1`).then(() => tx.insert(openingBalances).values({ tenantId: tenantB, openingEntryId: draftId, createdBy: ownerB, ...values } as typeof openingBalances.$inferInsert))));
    expect(await line({ kind: "account", accountId: of("1111"), debit: "1" })).toBe("SE041");
  });
});
