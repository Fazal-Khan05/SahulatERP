import "server-only";
import { asc, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { fiscalPeriods, numberSeries } from "./schema";

export type FiscalPeriodRow = { id: string; yearStart: string; periodNo: number; startsOn: string; endsOn: string; lockedAt: Date | null };

/** Every fiscal period of the company, oldest first. Open to every member: any document needs it. */
export async function listFiscalPeriods(ctx: TenantContext): Promise<FiscalPeriodRow[]> {
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: fiscalPeriods.id, yearStart: fiscalPeriods.yearStart, periodNo: fiscalPeriods.periodNo, startsOn: fiscalPeriods.startsOn, endsOn: fiscalPeriods.endsOn, lockedAt: fiscalPeriods.lockedAt })
      .from(fiscalPeriods)
      .where(eq(fiscalPeriods.tenantId, ctx.tenantId))
      .orderBy(asc(fiscalPeriods.startsOn)),
  );
}

/** The counters behind document numbers: the next number each kind of document will get, per fiscal year. */
export async function listNumberSeries(ctx: TenantContext): Promise<{ documentType: string; yearStart: string; yearCode: string; nextNumber: number }[]> {
  if (!can(ctx.role, "period.read")) throw new UserError("Only an owner, an accountant or an auditor can see the document counters.");
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ documentType: numberSeries.documentType, yearStart: numberSeries.yearStart, yearCode: numberSeries.yearCode, nextNumber: numberSeries.nextNumber })
      .from(numberSeries)
      .where(eq(numberSeries.tenantId, ctx.tenantId))
      .orderBy(asc(numberSeries.yearStart), asc(numberSeries.documentType)),
  );
}
