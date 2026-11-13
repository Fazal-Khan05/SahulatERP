import "server-only";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db";
import type { TenantContext } from "@/modules/tenant/rules";
import { isAccountTemplate, type AccountTemplate } from "./rules";
import { companySetup } from "./schema";

export type CompanySetup = {
  salesTaxRegistered: boolean;
  /** Whether the company's prices already include sales tax. False when it is not registered. */
  pricesIncludeTax: boolean;
  ntn: string | null;
  strn: string | null;
  accountsTemplate: AccountTemplate | null;
  completedAt: Date;
};

/**
 * What the company said in the setup wizard, or null while the wizard is unfinished. Open to
 * every member: whether the company is registered for sales tax decides what documents show.
 */
export async function getCompanySetup(ctx: TenantContext): Promise<CompanySetup | null> {
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ salesTaxRegistered: companySetup.salesTaxRegistered, pricesIncludeTax: companySetup.pricesIncludeTax, ntn: companySetup.ntn, strn: companySetup.strn, accountsTemplate: companySetup.accountsTemplate, completedAt: companySetup.completedAt })
      .from(companySetup)
      .where(eq(companySetup.tenantId, ctx.tenantId)),
  );
  return row ? { ...row, accountsTemplate: isAccountTemplate(row.accountsTemplate) ? row.accountsTemplate : null } : null;
}
