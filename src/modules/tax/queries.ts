import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { isIsoDate } from "@/modules/currencies/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { inForceOn, withholdingCodeSchema, type TaxCategoryKind, type WithholdingBase, type WithholdingKind } from "./rules";
import { taxCategories, taxRates, withholdingRules } from "./schema";

const NO_ACCESS = "Only an owner, an accountant or an auditor can see the tax rates.";

export type TaxCategoryRow = {
  id: string;
  name: string;
  kind: TaxCategoryKind;
  sroScheduleNo: string | null;
  sroItemSerial: string | null;
};

export type TaxRateRow = {
  id: string;
  categoryId: string;
  effectiveFrom: string;
  rate: Decimal;
  furtherTaxRate: Decimal;
  legalReference: string;
  /** True for the row that applies on the day asked about. */
  inForce: boolean;
};

export type WithholdingRuleRow = {
  id: string;
  kind: WithholdingKind;
  code: string;
  label: string;
  effectiveFrom: string;
  base: WithholdingBase;
  rate: Decimal;
  rateNonAtl: Decimal | null;
  legalReference: string;
  inForce: boolean;
};

/** Marks, in each group, the row in force on a date. */
function markInForce<T extends { id: string; effectiveFrom: string }>(rows: T[], groupOf: (row: T) => string, on: string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(groupOf(row), [...(groups.get(groupOf(row)) ?? []), row]);
  const current = new Set([...groups.values()].map((group) => inForceOn(group, on)?.id));
  return rows.map((row) => ({ ...row, inForce: current.has(row.id) }));
}

/**
 * Everything the tax screen shows, in one round of queries: the categories, every dated rate
 * (newest first within a category) and every dated withholding rule, each marked when it is the
 * one in force on `on`.
 */
export async function listTaxTables(
  ctx: TenantContext,
  on: string,
): Promise<{ categories: TaxCategoryRow[]; rates: TaxRateRow[]; rules: WithholdingRuleRow[] }> {
  if (!can(ctx.role, "tax.read")) throw new UserError(NO_ACCESS);
  const [categories, rates, rules] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    Promise.all([
      tx
        .select({
          id: taxCategories.id,
          name: taxCategories.name,
          kind: taxCategories.kind,
          sroScheduleNo: taxCategories.sroScheduleNo,
          sroItemSerial: taxCategories.sroItemSerial,
        })
        .from(taxCategories)
        .where(eq(taxCategories.tenantId, ctx.tenantId))
        .orderBy(asc(taxCategories.kind), asc(taxCategories.name)),
      tx
        .select({
          id: taxRates.id,
          categoryId: taxRates.categoryId,
          effectiveFrom: taxRates.effectiveFrom,
          rate: taxRates.rate,
          furtherTaxRate: taxRates.furtherTaxRate,
          legalReference: taxRates.legalReference,
        })
        .from(taxRates)
        .where(eq(taxRates.tenantId, ctx.tenantId))
        .orderBy(desc(taxRates.effectiveFrom)),
      tx
        .select({
          id: withholdingRules.id,
          kind: withholdingRules.kind,
          code: withholdingRules.code,
          label: withholdingRules.label,
          effectiveFrom: withholdingRules.effectiveFrom,
          base: withholdingRules.base,
          rate: withholdingRules.rate,
          rateNonAtl: withholdingRules.rateNonAtl,
          legalReference: withholdingRules.legalReference,
        })
        .from(withholdingRules)
        .where(eq(withholdingRules.tenantId, ctx.tenantId))
        .orderBy(asc(withholdingRules.kind), asc(withholdingRules.code), desc(withholdingRules.effectiveFrom)),
    ]),
  );
  return {
    categories,
    rates: markInForce(
      rates.map((row) => ({ ...row, rate: new Decimal(row.rate), furtherTaxRate: new Decimal(row.furtherTaxRate) })),
      (row) => row.categoryId,
      on,
    ),
    rules: markInForce(
      rules.map((row) => ({ ...row, rate: new Decimal(row.rate), rateNonAtl: row.rateNonAtl === null ? null : new Decimal(row.rateNonAtl) })),
      (row) => row.code,
      on,
    ),
  };
}

/**
 * The rate of a sales-tax category on a date: the latest row effective on or before it, so a
 * document dated before a change gets the rate that applied then. Null when the category is not
 * this company's or had no rate yet by that date; a document must then refuse to guess.
 *
 * Open to every member: any document with a taxed line needs it.
 */
export async function getTaxRateOn(
  ctx: TenantContext,
  categoryId: string,
  date: string,
): Promise<{ kind: TaxCategoryKind; rate: Decimal; furtherTaxRate: Decimal; effectiveFrom: string } | null> {
  if (!isUuid(categoryId) || !isIsoDate(date)) return null;
  const [found] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        kind: taxCategories.kind,
        rate: taxRates.rate,
        furtherTaxRate: taxRates.furtherTaxRate,
        effectiveFrom: taxRates.effectiveFrom,
      })
      .from(taxRates)
      .innerJoin(taxCategories, and(eq(taxCategories.tenantId, taxRates.tenantId), eq(taxCategories.id, taxRates.categoryId)))
      .where(and(eq(taxRates.tenantId, ctx.tenantId), eq(taxRates.categoryId, categoryId), lte(taxRates.effectiveFrom, date)))
      .orderBy(desc(taxRates.effectiveFrom))
      .limit(1),
  );
  if (!found) return null;
  return { ...found, rate: new Decimal(found.rate), furtherTaxRate: new Decimal(found.furtherTaxRate) };
}

/**
 * The withholding rule with this code on a date, or null when it did not exist yet by then.
 * Open to every member, for the same reason as getTaxRateOn.
 */
export async function getWithholdingRuleOn(
  ctx: TenantContext,
  code: string,
  date: string,
): Promise<{ kind: WithholdingKind; base: WithholdingBase; rate: Decimal; rateNonAtl: Decimal | null; effectiveFrom: string } | null> {
  if (!withholdingCodeSchema.safeParse(code).success || !isIsoDate(date)) return null;
  const [found] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        kind: withholdingRules.kind,
        base: withholdingRules.base,
        rate: withholdingRules.rate,
        rateNonAtl: withholdingRules.rateNonAtl,
        effectiveFrom: withholdingRules.effectiveFrom,
      })
      .from(withholdingRules)
      .where(and(eq(withholdingRules.tenantId, ctx.tenantId), eq(withholdingRules.code, code), lte(withholdingRules.effectiveFrom, date)))
      .orderBy(desc(withholdingRules.effectiveFrom))
      .limit(1),
  );
  if (!found) return null;
  return { ...found, rate: new Decimal(found.rate), rateNonAtl: found.rateNonAtl === null ? null : new Decimal(found.rateNonAtl) };
}
