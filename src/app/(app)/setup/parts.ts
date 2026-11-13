import "server-only";
import { listCurrencies } from "@/modules/currencies/queries";
import { hasAccounts } from "@/modules/ledger/queries";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import { listBranches } from "@/modules/tenant/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { listWarehouses } from "@/modules/warehouses/queries";

/** The parts of setup that may already be in place, read from the tables that own them. */
export async function existingSetupParts(session: TenantContext) {
  const [currencies, periods, branches, warehouses, accounts] = await Promise.all([listCurrencies(session), listFiscalPeriods(session), listBranches(session), listWarehouses(session), hasAccounts(session)]);
  return { base: currencies.find((currency) => currency.isBase) ?? null, firstPeriod: periods[0] ?? null, branch: branches[0] ?? null, warehouse: warehouses[0] ?? null, accounts };
}
