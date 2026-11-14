import "server-only";
import { todayIso } from "@/lib/format";
import { withTenant } from "@/db";
import { selectYearStart } from "@/modules/reports/queries";
import { readStockFilter, type StockFilter } from "@/modules/stock-reports/rules";
import type { TenantContext } from "@/modules/tenant/rules";

/**
 * What was asked for, with the fiscal year so far as the period when none was given. A branch
 * the member does not work in is dropped: the database would show them nothing for it anyway.
 */
export async function loadStockFilter(session: TenantContext, raw: Record<string, unknown>): Promise<StockFilter> {
  const today = todayIso(new Date());
  const filter = readStockFilter(raw, { yearStart: await withTenant(session.userId, session.tenantId, (tx) => selectYearStart(tx, session.tenantId, today)), today });
  // (getYearStart is for ledger-report readers only; the warehouse reads low stock too.)
  if (filter.branchId !== null && session.branchIds !== null && !session.branchIds.includes(filter.branchId)) return { ...filter, branchId: null };
  return filter;
}
