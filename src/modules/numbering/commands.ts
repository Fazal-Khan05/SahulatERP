import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { isIsoDate } from "@/modules/currencies/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { firstYearProblem, fiscalYearLabel, isDocumentType, monthlyPeriods, nextDay, periodName, readFirstYear, type DocumentType } from "./rules";
import { fiscalPeriods } from "./schema";

const NO_PERIOD = "SE001";
const LOCKED = "SE002";

/**
 * Takes the next number for a document, such as SI-2627-00001. It must be called inside the
 * transaction that writes the document: the database holds the counter until that transaction
 * ends, so numbers are consecutive, and a document that fails gives its number back.
 *
 * Nothing in the app computes a number; this asks the database function
 * app.next_document_number, which also refuses a date with no open fiscal period.
 */
export async function takeDocumentNumber(tx: Tx, type: DocumentType, date: string): Promise<string> {
  if (!isDocumentType(type) || !isIsoDate(date)) throw new UserError("A document needs a kind and a date before it can be numbered.");
  try {
    // A savepoint, so a refusal here leaves the caller's transaction usable.
    const rows = await tx.transaction((inner) => inner.execute<{ number: string }>(sql`select app.next_document_number(${type}, ${date}::date) as number`));
    return rows[0].number;
  } catch (error) {
    if (pgCode(error) === NO_PERIOD) throw new UserError(`No fiscal period is open for ${date.split("-").reverse().join("-")}. An owner opens the fiscal year under Settings, Fiscal periods.`);
    if (pgCode(error) === LOCKED) throw new UserError(`The period ${periodName(date)} is locked. An owner can unlock it under Settings, Fiscal periods.`);
    throw error;
  }
}

/**
 * Opens a fiscal year: twelve monthly periods. The company's first year starts in the month and
 * year given; every later year starts the day after the last one ends, whatever is given.
 * With `onlyFirst`, it opens nothing when a year is already open (the setup wizard asks this way).
 */
export async function openFiscalYear(ctx: TenantContext, raw: { month?: unknown; year?: unknown }, options: { onlyFirst?: boolean } = {}): Promise<{ yearStart: string }> {
  if (!can(ctx.role, "period.manage")) throw new UserError("Only an owner can open a fiscal year.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      // One opening at a time per company: a second waits here, then sees the year the first opened.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"fiscal-year:" + ctx.tenantId}, 0))`);
      const [last] = await tx.select({ endsOn: fiscalPeriods.endsOn }).from(fiscalPeriods).where(eq(fiscalPeriods.tenantId, ctx.tenantId)).orderBy(desc(fiscalPeriods.startsOn)).limit(1);
      let yearStart: string;
      // Asked only for a first year, and one is already open: someone got there first.
      if (last && options.onlyFirst) return { yearStart: last.endsOn };
      if (last) yearStart = nextDay(last.endsOn);
      else {
        const first = readFirstYear(raw);
        if (!first.ok) throw new UserError(first.reason);
        const problem = firstYearProblem(first.start, new Date().getUTCFullYear());
        if (problem) throw new UserError(problem);
        yearStart = first.start;
      }
      await tx.insert(fiscalPeriods).values(monthlyPeriods(yearStart).map((period) => ({ tenantId: ctx.tenantId, yearStart, ...period, createdBy: ctx.userId })));
      await audit(tx, ctx, { action: "fiscal_year.open", entity: "fiscal_year", after: { year: fiscalYearLabel(yearStart), from: yearStart } });
      return { yearStart };
    });
  } catch (error) {
    // Two owners at the same moment: the database lets one through.
    if (pgCode(error) === "23505") throw new UserError("That fiscal year is already open.");
    throw error;
  }
}

/** Locks a period so nothing more can be written into it, or unlocks it. Owner only. */
export async function setPeriodLocked(ctx: TenantContext, periodId: unknown, locked: boolean): Promise<void> {
  if (!can(ctx.role, "period.manage")) throw new UserError("Only an owner can lock or unlock a period.");
  if (!isUuid(periodId)) throw new UserError("That period is not in this company.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const mine = and(eq(fiscalPeriods.tenantId, ctx.tenantId), eq(fiscalPeriods.id, periodId));
    const [period] = await tx.select({ startsOn: fiscalPeriods.startsOn, lockedAt: fiscalPeriods.lockedAt }).from(fiscalPeriods).where(mine).for("update");
    if (!period) throw new UserError("That period is not in this company.");
    if ((period.lockedAt !== null) === locked) return;
    await tx.update(fiscalPeriods).set({ lockedAt: locked ? sql`now()` : null, lockedBy: locked ? ctx.userId : null }).where(mine);
    await audit(tx, ctx, {
      action: locked ? "fiscal_period.lock" : "fiscal_period.unlock",
      entity: "fiscal_period",
      entityId: periodId,
      before: { period: periodName(period.startsOn), locked: !locked },
      after: { period: periodName(period.startsOn), locked },
    });
  });
}
