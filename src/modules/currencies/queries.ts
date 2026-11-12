import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { isIsoDate } from "./rules";
import { currencies, exchangeRates } from "./schema";

const NO_ACCESS = "Only an owner, an accountant or an auditor can see the currencies.";

export type CurrencyRow = {
  id: string;
  code: string;
  name: string;
  isBase: boolean;
  /** The newest rate entered, whatever its date; null for the base currency or when none exists. */
  latest: { rate: Decimal; date: string } | null;
};

/** The company's currencies, base first, each with its newest rate. */
export async function listCurrencies(ctx: TenantContext): Promise<CurrencyRow[]> {
  if (!can(ctx.role, "currency.read")) throw new UserError(NO_ACCESS);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [rows, newest] = await Promise.all([
      tx
        .select({ id: currencies.id, code: currencies.code, name: currencies.name, isBase: currencies.isBase })
        .from(currencies)
        .where(eq(currencies.tenantId, ctx.tenantId))
        .orderBy(desc(currencies.isBase), asc(currencies.code)),
      tx
        .selectDistinctOn([exchangeRates.currencyId], {
          currencyId: exchangeRates.currencyId,
          rate: exchangeRates.rate,
          date: exchangeRates.rateDate,
        })
        .from(exchangeRates)
        .where(eq(exchangeRates.tenantId, ctx.tenantId))
        .orderBy(exchangeRates.currencyId, desc(exchangeRates.rateDate)),
    ]);
    const latest = new Map(newest.map((r) => [r.currencyId, { rate: new Decimal(r.rate), date: r.date }]));
    return rows.map((row) => ({ ...row, latest: latest.get(row.id) ?? null }));
  });
}

/** The rates entered most recently, newest date first. */
export async function listRates(ctx: TenantContext, limit = 60) {
  if (!can(ctx.role, "currency.read")) throw new UserError(NO_ACCESS);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: exchangeRates.id,
        code: currencies.code,
        date: exchangeRates.rateDate,
        rate: exchangeRates.rate,
        source: exchangeRates.source,
      })
      .from(exchangeRates)
      .innerJoin(currencies, and(eq(currencies.tenantId, exchangeRates.tenantId), eq(currencies.id, exchangeRates.currencyId)))
      .where(eq(exchangeRates.tenantId, ctx.tenantId))
      .orderBy(desc(exchangeRates.rateDate), asc(currencies.code))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, rate: new Decimal(row.rate) }));
}

/**
 * The rate in force for a currency on a date: the latest rate dated on or before it. The base
 * currency is always 1. Null when the currency is not this company's or has no rate yet by
 * that date; a document must then refuse to guess.
 *
 * Open to every member: any document in a foreign currency needs it.
 */
export async function getRateOn(
  ctx: TenantContext,
  currencyId: string,
  date: string,
): Promise<{ rate: Decimal; date: string } | null> {
  if (!isUuid(currencyId) || !isIsoDate(date)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [[currency], [found]] = await Promise.all([
      tx
        .select({ isBase: currencies.isBase })
        .from(currencies)
        .where(and(eq(currencies.tenantId, ctx.tenantId), eq(currencies.id, currencyId))),
      tx
        .select({ rate: exchangeRates.rate, date: exchangeRates.rateDate })
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.tenantId, ctx.tenantId),
            eq(exchangeRates.currencyId, currencyId),
            lte(exchangeRates.rateDate, date),
          ),
        )
        .orderBy(desc(exchangeRates.rateDate))
        .limit(1),
    ]);
    if (!currency) return null;
    if (currency.isBase) return { rate: new Decimal(1), date };
    return found ? { rate: new Decimal(found.rate), date: found.date } : null;
  });
}
