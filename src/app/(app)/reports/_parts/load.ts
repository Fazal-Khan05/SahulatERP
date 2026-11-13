import "server-only";
import { todayIso } from "@/lib/format";
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss, getTrialBalance, getYearStart } from "@/modules/reports/queries";
import { readFilter, type ReportFilter, type ReportKey, type ReportTable } from "@/modules/reports/rules";
import type { TenantContext } from "@/modules/tenant/rules";

type Raw = { from?: unknown; to?: unknown; branch?: unknown; account?: unknown };

/**
 * What was asked for, with the fiscal year so far as the period when none was given. A branch
 * the member does not work in is dropped: the database would show them nothing for it anyway.
 */
export async function loadFilter(session: TenantContext, raw: Raw): Promise<ReportFilter> {
  const today = todayIso(new Date());
  const filter = readFilter(raw, { yearStart: await getYearStart(session, today), today });
  if (filter.branchId !== null && session.branchIds !== null && !session.branchIds.includes(filter.branchId)) return { ...filter, branchId: null };
  return filter;
}

/** The report as a table, or null when a general ledger was asked for without an account of this company. */
export async function loadReport(session: TenantContext, report: ReportKey, filter: ReportFilter, ledgerLimit?: number): Promise<ReportTable | null> {
  switch (report) {
    case "trial-balance":
      return getTrialBalance(session, filter);
    case "profit-and-loss":
      return getProfitAndLoss(session, filter);
    case "balance-sheet":
      return getBalanceSheet(session, filter);
    case "general-ledger":
      return getGeneralLedger(session, filter, ledgerLimit);
  }
}
