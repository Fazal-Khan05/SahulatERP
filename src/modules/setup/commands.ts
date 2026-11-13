import "server-only";
import { sql } from "drizzle-orm";
import { audit, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { SetupInput } from "./rules";
import { companySetup } from "./schema";

export const SETUP_DONE = "This company is already set up.";

/** What the company actually has once the wizard's parts are done, read back from their own tables. */
export type SetupFacts = { baseCurrency: string; fiscalYearStart: string; branch: string; warehouse: string; modules: string[] };

/**
 * Runs the wizard's steps for one company at a time. A second submission, from another tab or
 * another owner, waits here until the first has finished, and then finds the company set up.
 * The lock lives on its own connection; the steps run on others, each in its own transaction.
 */
export async function withSetupLock<T>(ctx: TenantContext, run: () => Promise<T>): Promise<T> {
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"setup:" + ctx.tenantId}, 0))`);
    return run();
  });
}

/**
 * Records the company's answers and marks the wizard finished. Once, by the owner. The parts of
 * setup that belong to other modules (the base currency, the fiscal year, the modules, the first
 * branch and warehouse) are done through those modules' own commands before this is called; the
 * audit row describes them as they are (`facts`), which can differ from what was typed when a
 * part was already in place.
 */
export async function recordSetup(ctx: TenantContext, setup: SetupInput, facts: SetupFacts): Promise<void> {
  if (!can(ctx.role, "setup.complete")) throw new UserError("Only the owner can set up the company.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(companySetup)
        .values({
          tenantId: ctx.tenantId,
          salesTaxRegistered: setup.salesTaxRegistered,
          ntn: setup.ntn,
          strn: setup.strn,
          taxRatesConfirmedAt: setup.taxRatesConfirmed ? sql`now()` : null,
          pricesIncludeTax: setup.pricesIncludeTax,
          accountsTemplate: setup.accountsTemplate,
          completedBy: ctx.userId,
        })
        .returning({ id: companySetup.id });
      await audit(tx, ctx, {
        action: "company.setup",
        entity: "company_setup",
        entityId: row.id,
        after: {
          salesTaxRegistered: setup.salesTaxRegistered,
          ntn: setup.ntn,
          strn: setup.strn,
          taxRatesConfirmed: setup.taxRatesConfirmed,
          pricesIncludeTax: setup.pricesIncludeTax,
          baseCurrency: facts.baseCurrency,
          fiscalYearStart: facts.fiscalYearStart,
          bundle: setup.bundle,
          modules: facts.modules.join(", "),
          branch: facts.branch,
          warehouse: facts.warehouse,
          accountsTemplate: setup.accountsTemplate,
        },
      });
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new UserError(SETUP_DONE);
    throw error;
  }
}
