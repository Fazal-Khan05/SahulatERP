import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { selectAccounts } from "@/modules/ledger/queries";
import { JOURNAL_SOURCES, checkJournalLines } from "@/modules/ledger/rules";
import { accounts } from "@/modules/ledger/schema";
import { periodRefusal } from "@/modules/numbering/rules";
import { fiscalPeriods } from "@/modules/numbering/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { ManualJournalStatus } from "./rules";
import { manualJournalLines, manualJournals } from "./schema";

export function requireJournalAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "journal.read")) throw new UserError("Only an owner, an accountant or an auditor can see journals.");
}

export type ManualJournalLine = { lineNo: number; accountId: string; accountCode: string; accountName: string; description: string | null; debit: Decimal; credit: Decimal };

export type ManualJournal = {
  id: string;
  status: ManualJournalStatus;
  date: string;
  memo: string;
  branchId: string | null;
  number: string | null;
  journalId: string | null;
  reversalJournalId: string | null;
  postedAt: Date | null;
  reversedAt: Date | null;
  updatedAt: Date;
  lines: ManualJournalLine[];
};

const header = {
  id: manualJournals.id,
  status: manualJournals.status,
  date: manualJournals.journalDate,
  memo: manualJournals.memo,
  branchId: manualJournals.branchId,
  number: manualJournals.number,
  journalId: manualJournals.journalId,
  reversalJournalId: manualJournals.reversalJournalId,
  postedAt: manualJournals.postedAt,
  reversedAt: manualJournals.reversedAt,
  updatedAt: manualJournals.updatedAt,
};

/** One manual journal with its lines, inside a transaction the caller already holds. */
export async function selectManualJournal(tx: Tx, tenantId: string, id: string, lock?: SQL): Promise<ManualJournal | null> {
  if (lock) {
    // Held first, then read: what is read below cannot change until the transaction ends.
    const held = await tx.execute(sql`select 1 from ${manualJournals} where ${manualJournals.tenantId} = ${tenantId} and ${manualJournals.id} = ${id} ${lock}`);
    if (held.length === 0) return null;
  }
  const [row] = await tx.select(header).from(manualJournals).where(and(eq(manualJournals.tenantId, tenantId), eq(manualJournals.id, id)));
  if (!row) return null;
  const lines = await tx
    .select({
      lineNo: manualJournalLines.lineNo,
      accountId: manualJournalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      description: manualJournalLines.description,
      debit: manualJournalLines.debit,
      credit: manualJournalLines.credit,
    })
    .from(manualJournalLines)
    .innerJoin(accounts, and(eq(accounts.tenantId, manualJournalLines.tenantId), eq(accounts.id, manualJournalLines.accountId)))
    .where(and(eq(manualJournalLines.tenantId, tenantId), eq(manualJournalLines.manualJournalId, id)))
    .orderBy(asc(manualJournalLines.lineNo));
  return {
    ...row,
    status: row.status as ManualJournalStatus,
    lines: lines.map((line) => ({ ...line, debit: new Decimal(line.debit), credit: new Decimal(line.credit) })),
  };
}

/** One manual journal with its lines, or null when it is not this company's (or not in this member's branches). */
export async function getManualJournal(ctx: TenantContext, id: string): Promise<ManualJournal | null> {
  requireJournalAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectManualJournal(tx, ctx.tenantId, id));
}

export const JOURNAL_LIST_LIMIT = 200;

export type ManualJournalRow = { id: string; status: ManualJournalStatus; date: string; memo: string; number: string | null; total: Decimal; lines: number };

/** The newest manual journals first: drafts by when they were last changed, then by date. At most JOURNAL_LIST_LIMIT. */
export async function listManualJournals(ctx: TenantContext): Promise<{ rows: ManualJournalRow[]; more: boolean }> {
  requireJournalAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: manualJournals.id,
        status: manualJournals.status,
        date: manualJournals.journalDate,
        memo: manualJournals.memo,
        number: manualJournals.number,
        // The outer table is named in full: a bare column name here would be read as the line's own.
        total: sql<string>`coalesce((select sum(l.debit) from public.manual_journal_lines l where l.tenant_id = public.manual_journals.tenant_id and l.manual_journal_id = public.manual_journals.id), 0)`,
        lines: sql<number>`(select count(*)::int from public.manual_journal_lines l where l.tenant_id = public.manual_journals.tenant_id and l.manual_journal_id = public.manual_journals.id)`,
      })
      .from(manualJournals)
      .where(eq(manualJournals.tenantId, ctx.tenantId))
      .orderBy(desc(manualJournals.journalDate), desc(manualJournals.createdAt))
      .limit(JOURNAL_LIST_LIMIT + 1),
  );
  return {
    more: found.length > JOURNAL_LIST_LIMIT,
    rows: found.slice(0, JOURNAL_LIST_LIMIT).map((row) => ({ ...row, status: row.status as ManualJournalStatus, total: new Decimal(row.total) })),
  };
}

/**
 * What stops these lines from being posted by a manual journal, by account: a heading, an
 * archived account, an account kept by its own documents, or one that is not this company's.
 */
export async function accountProblem(tx: Tx, ctx: TenantContext, draft: { lines: readonly { accountId: string }[] }): Promise<string | null> {
  const ids = [...new Set(draft.lines.map((line) => line.accountId))];
  if (ids.some((id) => !isUuid(id))) return "An account on the journal is not in this company.";
  if (ids.length === 0) return null;
  const found = new Map((await selectAccounts(tx, ctx.tenantId, inArray(accounts.id, ids))).map((account) => [account.id, account]));
  const blocked: readonly string[] = JOURNAL_SOURCES.manual_journal.blockedControls;
  for (const [index, line] of draft.lines.entries()) {
    const account = found.get(line.accountId);
    const at = `Line ${index + 1}`;
    if (!account) return `${at}: that account is not in this company.`;
    if (account.isGroup) return `${at}: ${account.code} ${account.name} is a heading. Choose one of the accounts under it.`;
    if (account.archivedAt !== null) return `${at}: ${account.code} ${account.name} is archived. Restore it, or choose another account.`;
    if (blocked.includes(account.controlType ?? "")) {
      return `${at}: ${account.code} ${account.name} cannot be used in a manual journal. It is kept by its own documents, so that it always agrees with them.`;
    }
  }
  return null;
}

/**
 * Why a draft cannot be posted as it stands, in the words posting would use, or null when
 * nothing stands in its way. It writes nothing and takes no number: for telling someone why
 * their journal was kept as a draft.
 */
export async function postProblem(ctx: TenantContext, id: unknown): Promise<string | null> {
  requireJournalAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const journal = await selectManualJournal(tx, ctx.tenantId, id);
    if (!journal || journal.status !== "draft") return null;
    const checked = checkJournalLines(journal.lines);
    if (!checked.ok) return checked.reason;
    const problem = await accountProblem(tx, ctx, journal);
    if (problem) return problem;
    const [period] = await tx
      .select({ lockedAt: fiscalPeriods.lockedAt })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.tenantId, ctx.tenantId), sql`${fiscalPeriods.startsOn} <= ${journal.date}::date and ${fiscalPeriods.endsOn} >= ${journal.date}::date`));
    return periodRefusal(!period ? "SE001" : period.lockedAt !== null ? "SE002" : undefined, journal.date);
  });
}
