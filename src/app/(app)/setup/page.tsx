import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { MONTHS } from "@/modules/numbering/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { ACCOUNT_TEMPLATES, MODULE_BUNDLES } from "@/modules/setup/rules";
import { can } from "@/modules/tenant/rules";
import { formatIsoDate } from "@/modules/currencies/rules";
import { completeSetupAction } from "./actions";
import { existingSetupParts } from "./parts";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Setup />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

async function Setup() {
  const session = await requireTenant();
  const done = await getCompanySetup(session);
  if (done) {
    return (
      <>
        <PageHead title="Set up" />
        <Card className="max-w-xl">
          <p className="mb-3" data-testid="setup-done">
            {session.tenantName} is set up. It is {done.salesTaxRegistered ? `registered for sales tax, with ${done.pricesIncludeTax ? "prices that include the tax" : "the tax added on top of its prices"}` : "not registered for sales tax"}
            {done.accountsTemplate ? `, and its accounts start from "${ACCOUNT_TEMPLATES[done.accountsTemplate]}"` : ""}.
          </p>
          <p className="mb-4 text-sm text-muted-foreground">Currencies, fiscal periods, modules, branches and warehouses are under Settings.</p>
          <Link href="/inbox" className={buttonVariants({ size: "sm" })}>
            Go to what needs attention
          </Link>
        </Card>
      </>
    );
  }
  if (!can(session.role, "setup.complete")) {
    return (
      <>
        <PageHead title="Set up" />
        <p className="text-muted-foreground">The owner has not finished setting up {session.tenantName} yet.</p>
      </>
    );
  }
  // Parts already in place, by hand under Settings or by an attempt that stopped half-way, are kept.
  const existing = await existingSetupParts(session);
  const today = todayIso(new Date());
  // The fiscal year that today falls in, for a year that starts in July.
  const fiscalYear = Number(today.slice(5, 7)) >= 7 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1);

  return (
    <>
      <PageHead title={`Set up ${session.tenantName}`} sub="A few questions, asked once. The currency and the fiscal year's first month can never be changed, and the sales tax answer cannot be changed here afterwards, so choose them with care. Modules, branches and warehouses can be changed under Settings." />
      <Card className="max-w-2xl">
        <ActionForm action={completeSetupAction} submitLabel="Finish setup">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-bold">Sales tax</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="salesTaxRegistered" value="no" required className="mt-0.5 size-4" />
              <span>
                Not registered for sales tax
                <span className="block text-xs text-muted-foreground">No sales tax is charged, and none is shown on invoices or anywhere else.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="salesTaxRegistered" value="yes" required className="mt-0.5 size-4" />
              <span>
                Registered for sales tax
                <span className="block text-xs text-muted-foreground">Invoices show sales tax. Fill in the fields below.</span>
              </span>
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="STRN" name="strn" autoComplete="off" hint="13 digits. Only if registered." />
              <Field label="NTN" name="ntn" autoComplete="off" hint="7 digits, with or without the check digit. Optional." />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pricesIncludeTax">Prices and sales tax</Label>
              <select id="pricesIncludeTax" name="pricesIncludeTax" defaultValue="" className={SELECT}>
                <option value="">Choose, only if registered</option>
                <option value="no">Sales tax is added on top of my prices</option>
                <option value="yes">My prices already include sales tax</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Only if registered. With prices that include the tax, the customer pays the price you set and the invoice shows the tax inside it.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="taxRatesConfirmed" className="mt-0.5 size-4" />
              <span>
                I have checked the tax rates this company will use
                <span className="block text-xs text-muted-foreground">
                  Only if registered. The starting rates are under Settings, Tax; the company is responsible for the rates it uses.
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-bold">Books</legend>
            {existing.base ? (
              <p className="text-sm" data-testid="existing-currency">
                The books are already kept in {existing.base.name} ({existing.base.code}).
              </p>
            ) : null}
            {existing.firstPeriod ? (
              <p className="text-sm" data-testid="existing-year">
                The first fiscal year is already open, from {formatIsoDate(existing.firstPeriod.yearStart)}.
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              {existing.base ? null : (
                <>
                  <Field label="Currency code" name="currencyCode" defaultValue="PKR" required maxLength={3} hint="The currency the books are kept in. It cannot be changed later." />
                  <Field label="Currency name" name="currencyName" defaultValue="Pakistani Rupee" required maxLength={60} />
                </>
              )}
              {existing.firstPeriod ? null : (
                <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fiscalMonth">Fiscal year starts in</Label>
                <select id="fiscalMonth" name="fiscalMonth" defaultValue="7" className={SELECT}>
                  {MONTHS.map((month, index) => (
                    <option key={month} value={index + 1}>
                      {month}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">July is usual in Pakistan. It cannot be changed later.</p>
              </div>
              <Field label="First fiscal year starts in" name="fiscalYear" defaultValue={fiscalYear} required inputMode="numeric" maxLength={4} hint="The calendar year, such as 2026 for the year 2026-27." />
                </>
              )}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-bold">What the company will use</legend>
            {Object.entries(MODULE_BUNDLES).map(([key, bundle]) => (
              <label key={key} className="flex items-start gap-2 text-sm">
                <input type="radio" name="bundle" value={key} defaultChecked={key === "importer"} className="mt-0.5 size-4" />
                <span>
                  {bundle.label}
                  <span className="block text-xs text-muted-foreground">{bundle.about}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-bold">First branch and warehouse</legend>
            {existing.branch ? (
              <p className="text-sm" data-testid="existing-branch">
                The company already has the branch {existing.branch.name}
                {existing.warehouse ? ` and the warehouse ${existing.warehouse.name}` : ""}.
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              {existing.branch ? null : <Field label="Branch" name="branchName" defaultValue="Main" required maxLength={80} />}
              {existing.warehouse ? null : <Field label="Warehouse" name="warehouseName" defaultValue="Main warehouse" required maxLength={80} />}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountsTemplate">Chart of accounts to start from</Label>
            <select id="accountsTemplate" name="accountsTemplate" defaultValue="trading" className={SELECT}>
              {Object.entries(ACCOUNT_TEMPLATES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
