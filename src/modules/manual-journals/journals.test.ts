import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { seedAccounts, setAccountArchived } from "@/modules/ledger/commands";
import { getJournal, listAccounts } from "@/modules/ledger/queries";
import type { AccountNode } from "@/modules/ledger/rules";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { listFiscalPeriods, listNumberSeries } from "@/modules/numbering/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { discardDraft, postManualJournal, reverseManualJournal, saveDraft } from "./commands";
import { getManualJournal, listManualJournals } from "./queries";
import { manualJournalLines, manualJournals } from "./schema";

// Manual journals against a real database, through the app's own path (app_runtime, withTenant,
// row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-journal-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const scopedAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@journal.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const scoped = ctx(scopedAccountant, tenantA, "accountant", [cityBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";

let admin: AdminSql;
let chart: AccountNode[];
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
const line = (code: string, debit: string, credit: string, description = "") => ({ accountId: account(code), description, debit, credit });
const rent = (amount: string, date = "2026-11-13", memo = "Shop rent for November") => ({ date, memo, branchId: "", lines: [line("5230", amount, "", "Shop rent"), line("1111", "", amount)] });

describe.skipIf(!hasDb)("manual journals", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: scopedAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    chart = await listAccounts(as.owner);
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("keeps a draft that can be changed, need not balance, and has no number", async () => {
    for (const role of ["auditor", "salesperson"] as const) await expect(saveDraft(as[role], null, rent("100")), role).rejects.toThrow("Only an owner or an accountant can write journals.");
    await expect(saveDraft(as.accountant, null, { ...rent("100"), memo: "" })).rejects.toThrow("Say what the journal is for.");
    const { id } = await saveDraft(as.accountant, null, { date: "2026-11-13", memo: "Half typed", branchId: "", lines: [line("5230", "100", "")] });
    const draft = await getManualJournal(as.auditor, id);
    expect(draft).toMatchObject({ status: "draft", number: null, journalId: null, date: "2026-11-13", memo: "Half typed" });
    expect(draft?.lines.map((l) => `${l.lineNo} ${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["1 5230 100.00 0.00"]);
    // Nothing is in the books yet.
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n).toBe(0);
    await expect(postManualJournal(as.accountant, id)).rejects.toThrow("A journal needs at least two lines: a debit and a credit.");

    // Saving again replaces the lines; a form opened before that cannot overwrite it.
    await saveDraft(as.owner, id, rent("250"), draft!.updatedAt.toISOString());
    await expect(saveDraft(as.accountant, id, rent("999"), draft!.updatedAt.toISOString())).rejects.toThrow("Someone changed this journal after you opened it.");
    const changed = await getManualJournal(as.owner, id);
    expect(changed?.lines.map((l) => `${l.lineNo} ${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["1 5230 250.00 0.00", "2 1111 0.00 250.00"]);

    // Accounts a manual journal cannot use are refused when the draft is saved, by line and by name.
    await expect(saveDraft(as.owner, null, { ...rent("5"), lines: [line("1200", "5", ""), line("1111", "", "5")] })).rejects.toThrow("Line 1: 1200 Trade receivables cannot be used in a manual journal.");
    await expect(saveDraft(as.owner, null, { ...rent("5"), lines: [line("1111", "5", ""), line("5200", "", "5")] })).rejects.toThrow("Line 2: 5200 Operating expenses is a heading. Choose one of the accounts under it.");
    await expect(saveDraft(as.owner, null, { ...rent("5"), lines: [{ accountId: randomUUID(), description: "", debit: "5", credit: "" }] })).rejects.toThrow("Line 1: that account is not in this company.");
    await expect(saveDraft(as.owner, null, { ...rent("5"), branchId: randomUUID() })).rejects.toThrow("Choose one of your branches.");

    // A draft is thrown away without a trace in the books; the audit log remembers it.
    await expect(discardDraft(as.auditor, id)).rejects.toThrow("Only an owner or an accountant can write journals.");
    await discardDraft(as.accountant, id);
    expect(await getManualJournal(as.owner, id)).toBeNull();
    const audited = await admin`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'manual_journal' and entity_id = ${id} order by at`;
    expect(audited.map((a) => a.action)).toEqual(["manual_journal.create", "manual_journal.update", "manual_journal.discard"]);
  });

  it("posts a balanced draft: it takes the next number and its journal goes into the books", async () => {
    const { id } = await saveDraft(as.accountant, null, { date: "2026-11-13", memo: "Shop rent and bank charges", branchId: "", lines: [line("5230", "40000", "", "November rent"), line("5810", "150.5", ""), line("1111", "", "40150.5")] });
    const unbalanced = await saveDraft(as.accountant, null, { ...rent("100"), lines: [line("5230", "100", ""), line("1111", "", "99")] });
    await expect(postManualJournal(as.accountant, unbalanced.id)).rejects.toThrow("The journal does not balance: debits are 100.00 and credits are 99.00.");
    await expect(postManualJournal(as.auditor, id)).rejects.toThrow("Only an owner or an accountant can write journals.");

    expect(await postManualJournal(as.accountant, id)).toEqual({ number: "JV-2627-00001" });
    const posted = await getManualJournal(as.auditor, id);
    expect(posted).toMatchObject({ status: "posted", number: "JV-2627-00001" });
    const journal = await getJournal(as.auditor, posted!.journalId!);
    expect(journal).toMatchObject({ date: "2026-11-13", sourceType: "manual_journal", sourceId: id, documentNumber: "JV-2627-00001", memo: "Shop rent and bank charges" });
    expect(journal?.lines.map((l) => `${l.lineNo} ${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)} ${l.description ?? ""}`)).toEqual(["1 5230 40000.00 0.00 November rent", "2 5810 150.50 0.00 ", "3 1111 0.00 40150.50 "]);

    // What is posted is what was just saved: a save by someone else in between is refused.
    const mine = await saveDraft(as.owner, null, rent("70"));
    await saveDraft(as.accountant, mine.id, rent("7000"));
    await expect(postManualJournal(as.owner, mine.id, mine.updatedAt)).rejects.toThrow("Someone changed this journal after you opened it.");
    await discardDraft(as.owner, mine.id);
    // Once posted it is never changed, posted again or thrown away.
    await expect(postManualJournal(as.owner, id)).rejects.toThrow("This journal is already posted.");
    await expect(saveDraft(as.owner, id, rent("1"))).rejects.toThrow("This journal is posted and cannot be changed. Reverse it instead.");
    await expect(discardDraft(as.owner, id)).rejects.toThrow("This journal is posted and cannot be removed. Reverse it instead.");
    // Two posted at the same moment get the next two numbers, neither skipped nor shared.
    const [a, b] = await Promise.all([saveDraft(as.owner, null, rent("10")), saveDraft(as.accountant, null, rent("20"))]);
    const numbers = await Promise.all([postManualJournal(as.owner, a.id), postManualJournal(as.accountant, b.id)]);
    expect(numbers.map((n) => n.number).sort()).toEqual(["JV-2627-00002", "JV-2627-00003"]);
    // The same draft posted twice at once is posted once.
    const c = await saveDraft(as.owner, null, rent("30"));
    const twice = await Promise.allSettled([postManualJournal(as.owner, c.id), postManualJournal(as.accountant, c.id)]);
    expect(twice.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n).toBe(4);

    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'manual_journal.post' and entity_id = ${id}`;
    expect(audited).toMatchObject({ actor_role: "accountant", after: { number: "JV-2627-00001", date: "2026-11-13", lines: 3, debit: "40150.5000", credit: "40150.5000" } });
    const list = await listManualJournals(as.auditor);
    expect(list.rows.find((r) => r.id === id)).toMatchObject({ number: "JV-2627-00001", status: "posted", lines: 3 });
    expect(list.rows.find((r) => r.id === id)?.total.toFixed(2)).toBe("40150.50");
    expect(list.rows.find((r) => r.id === unbalanced.id)).toMatchObject({ number: null, status: "draft" });
    await expect(listManualJournals(as.salesperson)).rejects.toThrow("Only an owner, an accountant or an auditor can see journals.");
  });

  it("refuses to post into a locked month, clearly, and takes no number for it", async () => {
    const august = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-08-01")!;
    const { id } = await saveDraft(as.accountant, null, rent("500", "2026-08-20", "August rent, entered late"));
    await setPeriodLocked(as.owner, august.id, true);
    await expect(postManualJournal(as.accountant, id)).rejects.toThrow("The period August 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");
    expect(await getManualJournal(as.owner, id)).toMatchObject({ status: "draft", number: null });
    // A draft can still be written and kept for a locked month; it just cannot be posted.
    await saveDraft(as.accountant, id, rent("550", "2026-08-21", "August rent, entered late"));
    await expect(postManualJournal(as.owner, id)).rejects.toThrow("The period August 2026 is locked.");
    await expect(postManualJournal(as.owner, (await saveDraft(as.owner, null, rent("5", "2026-06-30"))).id)).rejects.toThrow("No fiscal period is open for 30-06-2026.");
    const before = (await listNumberSeries(as.owner)).find((s) => s.documentType === "JV")!.nextNumber;
    await setPeriodLocked(as.owner, august.id, false);
    // The refusals above used up no number.
    expect((await postManualJournal(as.accountant, id)).number).toBe(`JV-2627-${String(before).padStart(5, "0")}`);
  });

  it("reverses a posted journal once, on a date in an open month", async () => {
    const { id } = await saveDraft(as.accountant, null, rent("7500", "2026-09-10", "September rent"));
    await expect(reverseManualJournal(as.owner, id, { date: "2026-09-12" })).rejects.toThrow("This journal is a draft.");
    const { number } = await postManualJournal(as.accountant, id);
    await expect(reverseManualJournal(as.auditor, id, { date: "2026-09-12" })).rejects.toThrow("Only an owner or an accountant can write journals.");
    await expect(reverseManualJournal(as.owner, id, { date: "" })).rejects.toThrow("Enter the date of the reversal.");
    await expect(reverseManualJournal(as.owner, id, { date: "2026-09-09" })).rejects.toThrow("A reversal is dated on or after the journal it reverses.");
    const october = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-10-01")!;
    await setPeriodLocked(as.owner, october.id, true);
    await expect(reverseManualJournal(as.owner, id, { date: "2026-10-05" })).rejects.toThrow("The period October 2026 is locked.");
    await setPeriodLocked(as.owner, october.id, false);

    const both = await Promise.allSettled([reverseManualJournal(as.owner, id, { date: "2026-10-05" }), reverseManualJournal(as.accountant, id, { date: "2026-10-05" })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const reversed = await getManualJournal(as.auditor, id);
    expect(reversed).toMatchObject({ status: "reversed", number });
    const reversal = await getJournal(as.auditor, reversed!.reversalJournalId!);
    expect(reversal).toMatchObject({ date: "2026-10-05", sourceType: "reversal", reversesJournalId: reversed!.journalId, documentNumber: null, memo: `Reversal of ${number}: September rent` });
    expect(reversal?.lines.map((l) => `${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["5230 0.00 7500.00", "1111 7500.00 0.00"]);
    await expect(reverseManualJournal(as.owner, id, { date: "2026-10-06" })).rejects.toThrow("This journal has already been reversed.");
    // The reversal took no number of its own.
    expect((await admin`select count(*)::int as n from public.manual_journals where tenant_id = ${tenantA} and number is not null`)[0].n + 1).toBe((await listNumberSeries(as.owner)).find((s) => s.documentType === "JV")!.nextNumber);
    const [audited] = await admin`select before, after from public.audit_log where tenant_id = ${tenantA} and action = 'manual_journal.reverse' and entity_id = ${id}`;
    expect(audited).toMatchObject({ before: { number, status: "posted" }, after: { number, status: "reversed", date: "2026-10-05" } });
  });

  it("refuses an account archived since the draft was written", async () => {
    const { id } = await saveDraft(as.accountant, null, { ...rent("60"), lines: [line("5330", "60", ""), line("1111", "", "60")] });
    await setAccountArchived(as.owner, account("5330"), true);
    await expect(postManualJournal(as.accountant, id)).rejects.toThrow("Line 1: 5330 Miscellaneous expenses is archived. Restore it, or choose another account.");
    await setAccountArchived(as.owner, account("5330"), false);
    await postManualJournal(as.accountant, id);
  });

  it("keeps a member limited to some branches to those branches", async () => {
    await expect(saveDraft(scoped, null, rent("15"))).rejects.toThrow("Choose the branch the journal belongs to.");
    await expect(saveDraft(scoped, null, { ...rent("15"), branchId: mainBranch })).rejects.toThrow("Choose one of your branches.");
    const city = await saveDraft(scoped, null, { ...rent("15"), branchId: cityBranch });
    const main = await saveDraft(as.owner, null, { ...rent("16"), branchId: mainBranch });
    const company = await saveDraft(as.owner, null, rent("17"));
    expect((await listManualJournals(scoped)).rows.map((r) => r.id)).toEqual([city.id]);
    expect(await getManualJournal(scoped, main.id)).toBeNull();
    for (const id of [main.id, company.id]) {
      await expect(postManualJournal(scoped, id), id).rejects.toThrow("That journal is not in this company.");
      await expect(discardDraft(scoped, id), id).rejects.toThrow("That journal is not in this company.");
    }
    await postManualJournal(scoped, city.id);
    const posted = await getManualJournal(scoped, city.id);
    expect((await getJournal(scoped, posted!.journalId!))?.branchId).toBe(cityBranch);
    await postManualJournal(as.owner, main.id);
    await expect(reverseManualJournal(scoped, main.id, { date: "2026-11-14" })).rejects.toThrow("That journal is not in this company.");
    // Another company sees none of it.
    expect((await listManualJournals(otherOwner)).rows).toEqual([]);
    expect(await getManualJournal(otherOwner, city.id)).toBeNull();
  });

  it("keeps the same rules in the database, whatever the app does", async () => {
    const draft = await saveDraft(as.accountant, null, rent("900"));
    const posted = await saveDraft(as.accountant, null, rent("901"));
    await postManualJournal(as.accountant, posted.id);
    const postedRow = (await getManualJournal(as.owner, posted.id))!;
    const mine = (id: string) => and(eq(manualJournals.tenantId, tenantA), eq(manualJournals.id, id));
    const linesOf = (id: string) => and(eq(manualJournalLines.tenantId, tenantA), eq(manualJournalLines.manualJournalId, id));
    const set = (who: string, id: string, change: Record<string, unknown>) => codeOf(() => withTenant(who, tenantA, (tx) => tx.update(manualJournals).set({ updatedBy: who, ...change }).where(mine(id))));

    // A draft cannot be marked posted without the journal the engine posted for it, in that transaction.
    expect(await set(userIds.accountant, draft.id, { status: "posted", number: "JV-2627-00099", journalId: postedRow.journalId, postedAt: new Date(), postedBy: userIds.accountant })).toBe("SE043");
    expect(await set(userIds.accountant, draft.id, { status: "posted" })).toBe("SE043");
    expect(await set(userIds.accountant, draft.id, { status: "reversed" })).toBe("SE043");
    expect(await set(userIds.accountant, draft.id, { number: "JV-2627-00099" })).toBe("23514");
    // A posted one cannot be edited, re-dated, sent back to draft, or reversed without a reversal.
    for (const change of [{ memo: "Changed" }, { journalDate: "2026-11-01" }, { status: "draft", number: null, journalId: null, postedAt: null, postedBy: null }, { status: "reversed", reversalJournalId: postedRow.journalId, reversedAt: new Date(), reversedBy: userIds.accountant }]) {
      expect(["SE041", "SE043"], JSON.stringify(change)).toContain(await set(userIds.accountant, posted.id, change));
    }
    // Its lines are frozen, and it cannot be deleted.
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.delete(manualJournalLines).where(linesOf(posted.id))))).toBe("SE041");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournalLines).values({ tenantId: tenantA, manualJournalId: posted.id, lineNo: 9, accountId: account("5230"), debit: "1", createdBy: userIds.owner })))).toBe("SE041");
    expect(await withTenant(userIds.owner, tenantA, (tx) => tx.delete(manualJournals).where(mine(posted.id)).returning({ id: manualJournals.id }))).toEqual([]);
    expect((await getManualJournal(as.owner, posted.id))?.lines).toHaveLength(2);

    // Who may write, and under whose name.
    const row = { tenantId: tenantA, journalDate: "2026-11-13", memo: "Raw insert", createdBy: userIds.auditor, updatedBy: userIds.auditor };
    expect(await codeOf(() => withTenant(userIds.auditor, tenantA, (tx) => tx.insert(manualJournals).values(row)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournals).values(row)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournals).values({ ...row, createdBy: userIds.owner, updatedBy: userIds.owner, tenantId: tenantB })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(scopedAccountant, tenantA, (tx) => tx.insert(manualJournals).values({ ...row, createdBy: scopedAccountant, updatedBy: scopedAccountant })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(scopedAccountant, tenantA, (tx) => tx.insert(manualJournals).values({ ...row, createdBy: scopedAccountant, updatedBy: scopedAccountant, branchId: mainBranch })))).toBe(DENIED);
    expect(await set(userIds.auditor, draft.id, { memo: "No" })).toBeUndefined();
    expect((await getManualJournal(as.owner, draft.id))?.memo).toBe("Shop rent for November");
    expect(await set(userIds.owner, draft.id, { createdBy: userIds.accountant })).toBe(DENIED);
    expect(await set(userIds.owner, draft.id, { updatedBy: userIds.accountant })).toBe(DENIED);
    // A line is one debit or one credit, and belongs to a journal the writer can see.
    const lineRow = { tenantId: tenantA, manualJournalId: draft.id, lineNo: 9, accountId: account("5230"), createdBy: userIds.owner };
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournalLines).values({ ...lineRow, debit: "1", credit: "1" })))).toBe("23514");
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournalLines).values({ ...lineRow })))).toBe("23514");
    expect(await codeOf(() => withTenant(userIds.auditor, tenantA, (tx) => tx.insert(manualJournalLines).values({ ...lineRow, debit: "1", createdBy: userIds.auditor })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(scopedAccountant, tenantA, (tx) => tx.insert(manualJournalLines).values({ ...lineRow, debit: "1", createdBy: scopedAccountant })))).toBe(DENIED);
    expect(await withTenant(userIds.salesperson, tenantA, (tx) => tx.select().from(manualJournals))).toEqual([]);
    expect(await withTenant(ownerB, tenantA, (tx) => tx.select().from(manualJournalLines))).toEqual([]);
    // A statement cannot change which company it is in half-way, to slip a row past these rules.
    const second = await saveDraft(as.accountant, null, rent("902"));
    const trick = (statement: ReturnType<typeof sql>) => codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.execute(statement)));
    expect(
      await trick(sql`update public.manual_journals
        set memo = case when id = ${second.id} and set_config('app.tenant_id', '', true) = '' then 'Slipped' else 'Slipped' end, updated_by = ${userIds.owner}
        where tenant_id = ${tenantA} and id in (${draft.id}, ${second.id})`),
    ).toBe(DENIED);
    expect(
      await trick(sql`insert into public.manual_journal_lines (tenant_id, manual_journal_id, line_no, account_id, debit, created_by)
        select ${tenantA}, v.journal, 9, ${account("5230")}, case when v.n = 2 and set_config('app.tenant_id', '', true) = '' then 1 else 1 end, ${userIds.owner}
        from (values (${draft.id}::uuid, 1), (${posted.id}::uuid, 2)) as v(journal, n)`),
    ).toBe(DENIED);
    expect((await getManualJournal(as.owner, posted.id))?.lines).toHaveLength(2);
    expect((await getManualJournal(as.owner, second.id))?.memo).toBe("Shop rent for November");
    // The times are the database's own, on a new row as on a changed one.
    const backdated = await withTenant(userIds.owner, tenantA, (tx) => tx.insert(manualJournals).values({ tenantId: tenantA, journalDate: "2026-11-13", memo: "Backdated", createdBy: userIds.owner, updatedBy: userIds.owner, createdAt: new Date("2001-01-01T00:00:00Z"), updatedAt: new Date("2001-01-01T00:00:00Z") }).returning({ id: manualJournals.id }));
    expect((await admin`select created_at > now() - interval '1 hour' as created, updated_at > now() - interval '1 hour' as updated from public.manual_journals where id = ${backdated[0].id}`)[0]).toEqual({ created: true, updated: true });
    await withTenant(userIds.owner, tenantA, (tx) => tx.update(manualJournals).set({ memo: "Renamed", updatedAt: new Date("1990-01-01T00:00:00Z"), updatedBy: userIds.owner }).where(mine(draft.id)));
    expect((await admin`select updated_at > now() - interval '1 hour' as fresh from public.manual_journals where id = ${draft.id}`)[0].fresh).toBe(true);
  });
});
