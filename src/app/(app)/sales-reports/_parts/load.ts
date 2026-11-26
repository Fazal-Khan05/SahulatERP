import "server-only";
import { withTenant } from "@/db";
import { todayIso } from "@/lib/format";
import { selectYearStart } from "@/modules/reports/queries";
import { readSalesFilter, type SalesFilter } from "@/modules/sales-reports/rules";
import type { TenantContext } from "@/modules/tenant/rules";

/**
 * What was asked for, with the fiscal year so far as the period when none was given. A branch
 * the member does not work in is dropped: the database would show them nothing for it anyway.
 */
export async function loadSalesFilter(session: TenantContext, raw: Record<string, unknown>): Promise<SalesFilter> {
  const today = todayIso(new Date());
  const filter = readSalesFilter(raw, { yearStart: await withTenant(session.userId, session.tenantId, (tx) => selectYearStart(tx, session.tenantId, today)), today });
  if (filter.branchId !== null && session.branchIds !== null && !session.branchIds.includes(filter.branchId)) return { ...filter, branchId: null };
  return filter;
}
