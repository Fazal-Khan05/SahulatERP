"use server";

import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { firstYearProblem } from "@/modules/numbering/rules";
import { SETUP_DONE, recordSetup, withSetupLock } from "@/modules/setup/commands";
import { getCompanySetup } from "@/modules/setup/queries";
import { MODULE_BUNDLES, moduleChanges, readSetup, type RawSetup } from "@/modules/setup/rules";
import { createBranch, setModuleEnabled } from "@/modules/tenant/commands";
import { MODULES, can } from "@/modules/tenant/rules";
import { createWarehouse } from "@/modules/warehouses/commands";
import { existingSetupParts } from "./parts";

/**
 * Finishes the setup wizard. Each part is done by the module that owns it, through that module's
 * own command and with its own audit row. A part already in place (set by hand under Settings,
 * or by an earlier attempt that stopped half-way) is kept and the answer typed for it ignored;
 * the modules are the exception, since the bundle chosen here says which are on. Everything is
 * checked before the first write, because the base currency and the fiscal year cannot be
 * undone. The last step records the answers, and that record is what marks the company set up.
 */
export async function completeSetupAction(_: FormState, formData: FormData): Promise<FormState> {
  const session = await requireTenant();
  if (!can(session.role, "setup.complete")) return { error: "Only the owner can set up the company." };
  try {
    // One submission at a time per company: a second one waits here, then finds the company set up.
    return await withSetupLock(session, async (): Promise<FormState> => {
      if (await getCompanySetup(session)) return { error: SETUP_DONE };

      const existing = await existingSetupParts(session);
      const raw: RawSetup = Object.fromEntries(["salesTaxRegistered", "ntn", "strn", "taxRatesConfirmed", "currencyCode", "currencyName", "fiscalMonth", "fiscalYear", "bundle", "branchName", "warehouseName", "accountsTemplate"].map((key) => [key, formData.get(key)]));
      if (existing.base) Object.assign(raw, { currencyCode: existing.base.code, currencyName: existing.base.name });
      if (existing.firstPeriod) Object.assign(raw, { fiscalMonth: String(Number(existing.firstPeriod.yearStart.slice(5, 7))), fiscalYear: existing.firstPeriod.yearStart.slice(0, 4) });
      if (existing.branch) raw.branchName = existing.branch.name;
      if (existing.warehouse) raw.warehouseName = existing.warehouse.name;
      const read = readSetup(raw);
      if (!read.ok) return { error: read.reason };
      const setup = read.setup;
      if (!existing.firstPeriod) {
        const problem = firstYearProblem(setup.fiscalYearStart, new Date().getUTCFullYear());
        if (problem) return { error: problem };
      }

      // Nothing is written above this line.
      if (!existing.base) await setBaseCurrency(session, setup.baseCurrency);
      if (!existing.firstPeriod) {
        await openFiscalYear(session, { month: String(Number(setup.fiscalYearStart.slice(5, 7))), year: setup.fiscalYearStart.slice(0, 4) }, { onlyFirst: true });
      }
      const wanted = MODULE_BUNDLES[setup.bundle].modules;
      for (const step of moduleChanges(session.modules, wanted)) await setModuleEnabled(session, step.module, step.enabled);
      const branch = existing.branch ?? (await createBranch(session, setup.branchName));
      if (!existing.warehouse) await createWarehouse(session, { name: setup.warehouseName, branchId: branch.id });

      await recordSetup(session, setup, {
        baseCurrency: setup.baseCurrency.code,
        fiscalYearStart: setup.fiscalYearStart,
        branch: branch.name,
        warehouse: setup.warehouseName,
        modules: MODULES.filter((key) => wanted[key]),
      });
      // A full page load: the menu follows the modules just chosen.
      return { location: "/inbox" };
    });
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("complete setup", error);
    return { error: "That did not work. Please try again; what was already done is kept." };
  }
}
