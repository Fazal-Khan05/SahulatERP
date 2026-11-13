import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { selectAccounts } from "@/modules/ledger/queries";
import { accounts, journalLines, journals } from "@/modules/ledger/schema";
import { fiscalPeriods } from "@/modules/numbering/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import {
  balanceSheet,
  balanceSheetTable,
  generalLedgerTable,
  profitAndLoss,
  profitAndLossTable,
  retainedEarnings,
  retainedEarningsStatement,
  runningBalance,
  trialBalance,
  trialBalanceTable,
  type AccountTotal,
  type LedgerEntry,
  type ReportAccount,
  type ReportFilter,
  type ReportTable,
  type Totals,
} from "./rules";

// The ledger reports, read straight from posted journal lines. Row-level security decides what
// the reader may see: a member limited to some branches gets the books of those branches only.

export function requireReportAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "report.read")) throw new UserError("Only an owner, an accountant or an auditor can see the ledger reports.");
}

/**
 * For every account with any entry up to `to`: debits less credits before `from`, and the
 * debits and the credits from `from` to `to`. One branch's lines only, when a branch is given.
 * With `movementsOnly`, nothing before `from` is read and `before` is nil.
 */
export async function selectTotals(tx: Tx, tenantId: string, range: { from: string; to: string; branchId: string | null; movementsOnly?: boolean }): Promise<Totals> {
  const rows = await tx.execute<{ account_id: string; before: string; debit: string; credit: string }>(sql`
    select l.account_id,
      coalesce(sum(l.debit - l.credit) filter (where j.journal_date < ${range.from}::date), 0)::text as before,
      coalesce(sum(l.debit) filter (where j.journal_date >= ${range.from}::date), 0)::text as debit,
      coalesce(sum(l.credit) filter (where j.journal_date >= ${range.from}::date), 0)::text as credit
    from public.journal_lines l
    join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    where l.tenant_id = ${tenantId} and j.journal_date <= ${range.to}::date
      and (${range.branchId}::uuid is null or l.branch_id = ${range.branchId}::uuid)
      -- A report of movements alone need not read the years before its period.
      and (${range.movementsOnly ?? false}::boolean is false or j.journal_date >= ${range.from}::date)
    group by l.account_id`);
  return new Map(rows.map((row): [string, AccountTotal] => [row.account_id, { before: new Decimal(row.before), debit: new Decimal(row.debit), credit: new Decimal(row.credit) }]));
}

/**
 * The first day of the fiscal year a date falls in. A date after the last year that was opened
 * counts from that year's pattern; a date before the first counts from itself.
 */
export async function selectYearStart(tx: Tx, tenantId: string, date: string): Promise<string> {
  const [period] = await tx
    .select({ yearStart: fiscalPeriods.yearStart })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.tenantId, tenantId), lte(fiscalPeriods.yearStart, date)))
    .orderBy(desc(fiscalPeriods.yearStart))
    .limit(1);
  if (!period) return date;
  // The same month and day, in the latest year that does not run past the date.
  const monthDay = period.yearStart.slice(4);
  const sameYear = `${date.slice(0, 4)}${monthDay}`;
  return sameYear <= date ? sameYear : `${Number(date.slice(0, 4)) - 1}${monthDay}`;
}

/** The fiscal year start for a date, for the default period of a report. */
export async function getYearStart(ctx: TenantContext, date: string): Promise<string> {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectYearStart(tx, ctx.tenantId, date));
}

const reportAccounts = async (tx: Tx, tenantId: string): Promise<ReportAccount[]> => selectAccounts(tx, tenantId);

export async function getTrialBalance(ctx: TenantContext, filter: ReportFilter): Promise<ReportTable> {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [chart, totals] = [await reportAccounts(tx, ctx.tenantId), await selectTotals(tx, ctx.tenantId, filter)];
    return trialBalanceTable(trialBalance(chart, totals), filter);
  });
}

export async function getProfitAndLoss(ctx: TenantContext, filter: ReportFilter): Promise<ReportTable> {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [chart, totals] = [await reportAccounts(tx, ctx.tenantId), await selectTotals(tx, ctx.tenantId, { ...filter, movementsOnly: true })];
    return profitAndLossTable(profitAndLoss(chart, totals), filter);
  });
}

/** The balance sheet at the end of `filter.to`. Profit is split at the start of that day's fiscal year. */
export async function getBalanceSheet(ctx: TenantContext, filter: ReportFilter): Promise<ReportTable> {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const yearStart = await selectYearStart(tx, ctx.tenantId, filter.to);
    const [chart, totals] = [await reportAccounts(tx, ctx.tenantId), await selectTotals(tx, ctx.tenantId, { from: yearStart, to: filter.to, branchId: filter.branchId })];
    return balanceSheetTable(balanceSheet(chart, totals), filter.to);
  });
}

/** How many entries of one account a page of the general ledger shows. */
export const LEDGER_PAGE = 500;
/** How many a downloaded file holds. */
export const LEDGER_FILE = 20_000;

/**
 * One account's entries in a period, oldest first, with the balance after each. Null when the
 * account is not this company's or is a heading. At most `limit` entries; the table says when
 * there are more.
 */
export async function getGeneralLedger(ctx: TenantContext, filter: ReportFilter, limit: number = LEDGER_PAGE): Promise<ReportTable | null> {
  requireReportAccess(ctx);
  if (filter.accountId === null) return null;
  const accountId = filter.accountId;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [account] = await selectAccounts(tx, ctx.tenantId, eq(accounts.id, accountId));
    if (!account || account.isGroup) return null;
    // The outer table is named in full: a bare column name here would be read as the inner table's own.
    const reversed = sql`(select o.document_number from public.journals o where o.tenant_id = public.journals.tenant_id and o.id = public.journals.reverses_journal_id)`;
    const [openingRow] = await tx.execute<{ opening: string }>(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as opening
      from public.journal_lines l
      join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      where l.tenant_id = ${ctx.tenantId} and l.account_id = ${accountId}::uuid and j.journal_date < ${filter.from}::date
        and (${filter.branchId}::uuid is null or l.branch_id = ${filter.branchId}::uuid)`);
    const rows = await tx
      .select({
        date: journals.journalDate,
        documentNumber: journals.documentNumber,
        sourceType: journals.sourceType,
        reversedNumber: sql<string | null>`${reversed}`,
        memo: journals.memo,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journals, and(eq(journals.tenantId, journalLines.tenantId), eq(journals.id, journalLines.journalId)))
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalLines.accountId, accountId),
          sql`${journals.journalDate} between ${filter.from}::date and ${filter.to}::date`,
          filter.branchId === null ? undefined : eq(journalLines.branchId, filter.branchId),
        ),
      )
      .orderBy(asc(journals.journalDate), asc(journals.createdAt), asc(journals.id), asc(journalLines.lineNo))
      .limit(limit + 1);
    const entries = rows.slice(0, limit).map((row): LedgerEntry => ({
      date: row.date,
      reference: row.documentNumber ?? (row.sourceType === "reversal" ? `Reversal${row.reversedNumber ? ` of ${row.reversedNumber}` : ""}` : row.sourceType === "opening_balance" ? "Opening balances" : ""),
      description: row.description ?? row.memo ?? "",
      debit: new Decimal(row.debit),
      credit: new Decimal(row.credit),
    }));
    const opening = new Decimal(openingRow.opening);
    return generalLedgerTable(account, opening, runningBalance(opening, entries), filter, rows.length > limit);
  });
}

/**
 * What the owners have earned and left in the business at the end of a day: the figure whose
 * change over a period is that period's profit.
 */
export async function getRetainedEarnings(ctx: TenantContext, asAt: string, branchId: string | null = null): Promise<Decimal> {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => retainedEarnings(await reportAccounts(tx, ctx.tenantId), await selectTotals(tx, ctx.tenantId, { from: asAt, to: asAt, branchId })));
}

/**
 * How what the owners have earned changed from `from` to `to`: opening, the period's profit,
 * what was posted straight to retained earnings, and closing.
 */
export async function getRetainedEarningsStatement(ctx: TenantContext, range: { from: string; to: string; branchId?: string | null }) {
  requireReportAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) =>
    retainedEarningsStatement(await reportAccounts(tx, ctx.tenantId), await selectTotals(tx, ctx.tenantId, { from: range.from, to: range.to, branchId: range.branchId ?? null })),
  );
}

/** The accounts a general ledger can be asked for: everything that is not a heading, by code. */
export async function listLedgerAccounts(ctx: TenantContext): Promise<{ id: string; label: string }[]> {
  requireReportAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.isGroup, false))));
  return rows.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true })).map((row) => ({ id: row.id, label: `${row.code} ${row.name}` }));
}
