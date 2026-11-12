import "server-only";
import type Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { isIsoDate } from "@/modules/currencies/rules";
import { can, firstIssue, type TenantContext } from "@/modules/tenant/rules";
import {
  PERCENT_SCALE,
  checkNonAtlRate,
  checkRateForKind,
  legalReferenceSchema,
  parseOptionalPercent,
  parsePercent,
  sroTextSchema,
  taxCategoryKindSchema,
  taxCategoryNameSchema,
  withholdingCodeSchema,
} from "./rules";
import { taxCategories, taxRates, withholdingRules } from "./schema";

// Tax tables are changed only by adding a dated row: a new rate from a date. Saving a second row
// for the same date corrects the first, and the audit row keeps both values. Documents never
// take a rate from a form; they look it up here for their own date.

const UNIQUE_VIOLATION = "23505";
const NOT_ALLOWED = "Only an owner or an accountant can change tax rates.";
const NAME_TAKEN = "A category with this name already exists.";
const SAME_MOMENT = "Someone else saved a rate for that date at the same moment. Check the list and try again.";

/** The exact decimal as text: it goes to a numeric column and never passes through a JS number. */
const stored = (percent: Decimal) => percent.toFixed(PERCENT_SCALE);

type RateInput = { effectiveFrom: string; rate: Decimal; furtherTaxRate: Decimal; legalReference: string };

function rateInput(raw: { effectiveFrom: unknown; rate: unknown; furtherTaxRate: unknown; legalReference: unknown }): RateInput {
  if (!isIsoDate(raw.effectiveFrom)) throw new UserError("Enter the date the rate applies from.");
  const rate = parsePercent(raw.rate);
  if (!rate.ok) throw new UserError(rate.reason);
  // Asked for every time, even when it is 0: a blank must never quietly drop the further tax.
  if (typeof raw.furtherTaxRate !== "string" || raw.furtherTaxRate.trim() === "") {
    throw new UserError("Enter the further tax rate, or 0 if there is none.");
  }
  const further = parsePercent(raw.furtherTaxRate);
  if (!further.ok) throw new UserError(`Further tax: ${further.reason}`);
  const legalReference = legalReferenceSchema.safeParse(raw.legalReference);
  if (!legalReference.success) throw new UserError(firstIssue(legalReference.error));
  return {
    effectiveFrom: raw.effectiveFrom,
    rate: rate.percent,
    furtherTaxRate: further.percent,
    legalReference: legalReference.data,
  };
}

/** Adds a sales-tax category with its first rate, such as a reduced rate under an SRO. */
export async function addTaxCategory(
  ctx: TenantContext,
  raw: {
    name: unknown;
    kind: unknown;
    sroScheduleNo: unknown;
    sroItemSerial: unknown;
    effectiveFrom: unknown;
    rate: unknown;
    furtherTaxRate: unknown;
    legalReference: unknown;
  },
): Promise<{ id: string }> {
  if (!can(ctx.role, "tax.manage")) throw new UserError(NOT_ALLOWED);
  const name = taxCategoryNameSchema.safeParse(raw.name);
  if (!name.success) throw new UserError(firstIssue(name.error));
  const kind = taxCategoryKindSchema.safeParse(raw.kind);
  if (!kind.success) throw new UserError(firstIssue(kind.error));
  const sroScheduleNo = sroTextSchema.safeParse(raw.sroScheduleNo ?? "");
  if (!sroScheduleNo.success) throw new UserError(firstIssue(sroScheduleNo.error));
  const sroItemSerial = sroTextSchema.safeParse(raw.sroItemSerial ?? "");
  if (!sroItemSerial.success) throw new UserError(firstIssue(sroItemSerial.error));
  if (kind.data === "reduced" && sroScheduleNo.data === null) {
    throw new UserError("Enter the schedule or SRO that gives this reduced rate.");
  }
  const input = rateInput(raw);
  const sensible = checkRateForKind(kind.data, input.rate, input.furtherTaxRate);
  if (!sensible.ok) throw new UserError(sensible.reason);

  const category = { name: name.data, kind: kind.data, sroScheduleNo: sroScheduleNo.data, sroItemSerial: sroItemSerial.data };
  const rate = { effectiveFrom: input.effectiveFrom, rate: stored(input.rate), furtherTaxRate: stored(input.furtherTaxRate), legalReference: input.legalReference };
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      // "standard rate" beside "Standard rate" would only confuse, and neither could be removed.
      const sameName = await tx
        .select({ id: taxCategories.id })
        .from(taxCategories)
        .where(and(eq(taxCategories.tenantId, ctx.tenantId), sql`lower(${taxCategories.name}) = lower(${category.name})`));
      if (sameName.length > 0) throw new UserError(NAME_TAKEN);
      const [row] = await tx
        .insert(taxCategories)
        .values({ tenantId: ctx.tenantId, ...category, createdBy: ctx.userId })
        .returning({ id: taxCategories.id });
      await tx
        .insert(taxRates)
        .values({ tenantId: ctx.tenantId, categoryId: row.id, ...rate, createdBy: ctx.userId, updatedBy: ctx.userId });
      await audit(tx, ctx, { action: "tax_category.add", entity: "tax_category", entityId: row.id, after: { ...category, ...rate } });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(NAME_TAKEN);
    throw error;
  }
}

/**
 * Sets a category's rate from a date. Rates before that date stay as they were, so a document
 * dated earlier still finds the old rate.
 */
export async function setTaxRate(
  ctx: TenantContext,
  raw: { categoryId: unknown; effectiveFrom: unknown; rate: unknown; furtherTaxRate: unknown; legalReference: unknown },
): Promise<{ id: string }> {
  if (!can(ctx.role, "tax.manage")) throw new UserError(NOT_ALLOWED);
  if (!isUuid(raw.categoryId)) throw new UserError("Choose a category.");
  const categoryId = raw.categoryId;
  const input = rateInput(raw);
  const values = { rate: stored(input.rate), furtherTaxRate: stored(input.furtherTaxRate), legalReference: input.legalReference };

  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const sameDay = and(
        eq(taxRates.tenantId, ctx.tenantId),
        eq(taxRates.categoryId, categoryId),
        eq(taxRates.effectiveFrom, input.effectiveFrom),
      );
      const [[category], [existing]] = await Promise.all([
        tx
          .select({ name: taxCategories.name, kind: taxCategories.kind })
          .from(taxCategories)
          .where(and(eq(taxCategories.tenantId, ctx.tenantId), eq(taxCategories.id, categoryId))),
        tx
          .select({ id: taxRates.id, rate: taxRates.rate, furtherTaxRate: taxRates.furtherTaxRate, legalReference: taxRates.legalReference })
          .from(taxRates)
          .where(sameDay)
          // Held until this transaction ends: a second correction of the same date waits, then
          // records this one's value as what it replaced.
          .for("update"),
      ]);
      if (!category) throw new UserError("Choose a category from this company.");
      const sensible = checkRateForKind(category.kind, input.rate, input.furtherTaxRate);
      if (!sensible.ok) throw new UserError(sensible.reason);

      let id: string;
      if (existing) {
        id = existing.id;
        await tx.update(taxRates).set({ ...values, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(sameDay);
      } else {
        const [row] = await tx
          .insert(taxRates)
          .values({ tenantId: ctx.tenantId, categoryId, effectiveFrom: input.effectiveFrom, ...values, createdBy: ctx.userId, updatedBy: ctx.userId })
          .returning({ id: taxRates.id });
        id = row.id;
      }
      const described = { category: category.name, effectiveFrom: input.effectiveFrom };
      await audit(tx, ctx, {
        action: "tax_rate.set",
        entity: "tax_rate",
        entityId: id,
        before: existing
          ? { ...described, rate: existing.rate, furtherTaxRate: existing.furtherTaxRate, legalReference: existing.legalReference }
          : null,
        after: { ...described, ...values },
      });
      return { id };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(SAME_MOMENT);
    throw error;
  }
}

/**
 * Sets a withholding rule's rate from a date. The rule keeps its code, its wording and what the
 * percentage is taken of; only the rates and the reference are new.
 */
export async function setWithholdingRate(
  ctx: TenantContext,
  raw: { code: unknown; effectiveFrom: unknown; rate: unknown; rateNonAtl: unknown; legalReference: unknown },
): Promise<{ id: string }> {
  if (!can(ctx.role, "tax.manage")) throw new UserError(NOT_ALLOWED);
  const code = withholdingCodeSchema.safeParse(raw.code);
  if (!code.success) throw new UserError(firstIssue(code.error));
  if (!isIsoDate(raw.effectiveFrom)) throw new UserError("Enter the date the rate applies from.");
  const effectiveFrom = raw.effectiveFrom;
  const rate = parsePercent(raw.rate);
  if (!rate.ok) throw new UserError(rate.reason);
  const nonAtl = parseOptionalPercent(raw.rateNonAtl);
  if (!nonAtl.ok) throw new UserError(`Rate when not on the Active Taxpayers List: ${nonAtl.reason}`);
  const legalReference = legalReferenceSchema.safeParse(raw.legalReference);
  if (!legalReference.success) throw new UserError(firstIssue(legalReference.error));
  const values = {
    rate: stored(rate.percent),
    rateNonAtl: nonAtl.percent === null ? null : stored(nonAtl.percent),
    legalReference: legalReference.data,
  };

  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const ofCode = and(eq(withholdingRules.tenantId, ctx.tenantId), eq(withholdingRules.code, code.data));
      const rows = await tx
        .select({
          id: withholdingRules.id,
          kind: withholdingRules.kind,
          label: withholdingRules.label,
          base: withholdingRules.base,
          effectiveFrom: withholdingRules.effectiveFrom,
          rate: withholdingRules.rate,
          rateNonAtl: withholdingRules.rateNonAtl,
          legalReference: withholdingRules.legalReference,
        })
        .from(withholdingRules)
        .where(ofCode)
        .orderBy(desc(withholdingRules.effectiveFrom))
        // Held until this transaction ends, so a second correction of the same date waits its turn.
        .for("update");
      // The rule itself is not the user's to invent: only a line that exists can get a new rate.
      const newest = rows[0];
      if (!newest) throw new UserError("Choose a rule from the list.");
      const sensible = checkNonAtlRate(newest.kind, rate.percent, nonAtl.percent);
      if (!sensible.ok) throw new UserError(sensible.reason);
      const existing = rows.find((row) => row.effectiveFrom === effectiveFrom);

      let id: string;
      if (existing) {
        id = existing.id;
        await tx
          .update(withholdingRules)
          .set({ ...values, updatedAt: sql`now()`, updatedBy: ctx.userId })
          .where(and(ofCode, eq(withholdingRules.effectiveFrom, effectiveFrom)));
      } else {
        const [row] = await tx
          .insert(withholdingRules)
          .values({
            tenantId: ctx.tenantId,
            kind: newest.kind,
            code: code.data,
            label: newest.label,
            base: newest.base,
            effectiveFrom,
            ...values,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .returning({ id: withholdingRules.id });
        id = row.id;
      }
      const described = { code: code.data, effectiveFrom };
      await audit(tx, ctx, {
        action: "withholding_rule.set",
        entity: "withholding_rule",
        entityId: id,
        before: existing
          ? { ...described, rate: existing.rate, rateNonAtl: existing.rateNonAtl, legalReference: existing.legalReference }
          : null,
        after: { ...described, ...values },
      });
      return { id };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(SAME_MOMENT);
    throw error;
  }
}
