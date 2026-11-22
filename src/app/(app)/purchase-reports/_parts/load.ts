import "server-only";
import { todayIso } from "@/lib/format";
import { withTenant } from "@/db";
import { readPurchaseFilter, type PurchaseFilter } from "@/modules/purchase-reports/rules";
import { selectYearStart } from "@/modules/reports/queries";
import type { TenantContext } from "@/modules/tenant/rules";

/**
 * What was asked for, with the fiscal year so far as the period when none was given. A branch
 * the member does not work in is dropped: the database would show them nothing for it anyway.
 */
export async function loadPurchaseFilter(session: TenantContext, raw: Record<string, unknown>): Promise<PurchaseFilter> {
  const today = todayIso(new Date());
  const filter = readPurchaseFilter(raw, { yearStart: await withTenant(session.userId, session.tenantId, (tx) => selectYearStart(tx, session.tenantId, today)), today });
  if (filter.branchId !== null && session.branchIds !== null && !session.branchIds.includes(filter.branchId)) return { ...filter, branchId: null };
  return filter;
}
