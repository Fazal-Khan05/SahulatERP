import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { can, firstIssue, type TenantContext } from "@/modules/tenant/rules";
import { currencyCodeSchema, currencyNameSchema, isIsoDate, parseRate, rateSourceSchema, RATE_SCALE } from "./rules";
import { currencies, exchangeRates } from "./schema";

const UNIQUE_VIOLATION = "23505";
const BASE_IS_SET = "The base currency is already set and cannot be changed.";

function currencyInput(raw: { code: unknown; name: unknown }): { code: string; name: string } {
  const code = currencyCodeSchema.safeParse(raw.code);
  if (!code.success) throw new UserError(firstIssue(code.error));
  const name = currencyNameSchema.safeParse(raw.name);
  if (!name.success) throw new UserError(firstIssue(name.error));
  return { code: code.data, name: name.data };
}

/**
 * Chooses the company's base currency. Once, at setup: every amount in the books is kept in it,
 * so it can never change afterwards.
 */
export async function setBaseCurrency(ctx: TenantContext, raw: { code: unknown; name: unknown }): Promise<{ id: string }> {
  if (!can(ctx.role, "currency.set_base")) throw new UserError("Only an owner can choose the base currency.");
  const input = currencyInput(raw);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const existing = await tx
        .select({ id: currencies.id })
        .from(currencies)
        .where(and(eq(currencies.tenantId, ctx.tenantId), eq(currencies.isBase, true)));
      if (existing.length > 0) throw new UserError(BASE_IS_SET);
      const [row] = await tx
        .insert(currencies)
        .values({ tenantId: ctx.tenantId, ...input, isBase: true, createdBy: ctx.userId })
        .returning({ id: currencies.id });
      await audit(tx, ctx, { action: "currency.set_base", entity: "currency", entityId: row.id, after: input });
      return row;
    });
  } catch (error) {
    // Two owners at the same moment: the database lets one through.
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(BASE_IS_SET);
    throw error;
  }
}

/** Adds a foreign currency the company deals in. */
export async function addCurrency(ctx: TenantContext, raw: { code: unknown; name: unknown }): Promise<{ id: string }> {
  if (!can(ctx.role, "currency.manage")) throw new UserError("Only an owner or an accountant can add a currency.");
  const input = currencyInput(raw);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const base = await tx
        .select({ id: currencies.id })
        .from(currencies)
        .where(and(eq(currencies.tenantId, ctx.tenantId), eq(currencies.isBase, true)));
      if (base.length === 0) throw new UserError("Choose the base currency first.");
      const [row] = await tx
        .insert(currencies)
        .values({ tenantId: ctx.tenantId, ...input, createdBy: ctx.userId })
        .returning({ id: currencies.id });
      await audit(tx, ctx, { action: "currency.add", entity: "currency", entityId: row.id, after: input });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(`${input.code} is already in the list.`);
    throw error;
  }
}

/**
 * Sets a currency's rate from a date. A second rate for the same day corrects the first; the
 * audit row keeps both values.
 */
export async function setRate(
  ctx: TenantContext,
  raw: { currencyId: unknown; date: unknown; rate: unknown; source: unknown },
): Promise<{ id: string }> {
  if (!can(ctx.role, "currency.manage")) throw new UserError("Only an owner or an accountant can set a rate.");
  if (!isUuid(raw.currencyId)) throw new UserError("Choose a currency.");
  if (!isIsoDate(raw.date)) throw new UserError("Enter the date the rate applies from.");
  const parsed = parseRate(raw.rate);
  if (!parsed.ok) throw new UserError(parsed.reason);
  const source = rateSourceSchema.safeParse(raw.source);
  if (!source.success) throw new UserError(firstIssue(source.error));

  const currencyId = raw.currencyId;
  const date = raw.date;
  // The exact decimal as text: it goes to a numeric column and never passes through a JS number.
  const rate = parsed.rate.toFixed(RATE_SCALE);

  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [currency] = await tx
      .select({ code: currencies.code, isBase: currencies.isBase })
      .from(currencies)
      .where(and(eq(currencies.tenantId, ctx.tenantId), eq(currencies.id, currencyId)));
    if (!currency) throw new UserError("Choose a currency from this company.");
    if (currency.isBase) throw new UserError(`${currency.code} is the base currency; it has no exchange rate.`);

    const sameDay = and(
      eq(exchangeRates.tenantId, ctx.tenantId),
      eq(exchangeRates.currencyId, currencyId),
      eq(exchangeRates.rateDate, date),
    );
    const [existing] = await tx
      .select({ id: exchangeRates.id, rate: exchangeRates.rate, source: exchangeRates.source })
      .from(exchangeRates)
      .where(sameDay);

    let id: string;
    if (existing) {
      id = existing.id;
      await tx
        .update(exchangeRates)
        .set({ rate, source: source.data, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(sameDay);
    } else {
      const [row] = await tx
        .insert(exchangeRates)
        .values({ tenantId: ctx.tenantId, currencyId, rateDate: date, rate, source: source.data, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: exchangeRates.id });
      id = row.id;
    }
    await audit(tx, ctx, {
      action: "exchange_rate.set",
      entity: "exchange_rate",
      entityId: id,
      before: existing ? { currency: currency.code, date, rate: existing.rate, source: existing.source } : null,
      after: { currency: currency.code, date, rate, source: source.data },
    });
    return { id };
  });
}
