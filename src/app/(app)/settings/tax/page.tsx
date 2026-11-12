import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listTaxTables } from "@/modules/tax/queries";
import {
  TAX_CATEGORY_KINDS,
  TAX_CATEGORY_KIND_LABELS,
  WITHHOLDING_BASE_LABELS,
  WITHHOLDING_KINDS,
  WITHHOLDING_KIND_LABELS,
  formatPercent,
} from "@/modules/tax/rules";
import { can } from "@/modules/tenant/rules";
import { addTaxCategoryAction, setTaxRateAction, setWithholdingRateAction } from "../actions";

export const metadata: Metadata = { title: "Tax" };

export default function TaxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Tax />
    </Suspense>
  );
}

// As wide as its card, not as its longest option: the rule names are long.
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const LAW_HINT = "Where the rate comes from, such as the Finance Act or an SRO number.";

/** Says whether a dated row applies today, has been replaced, or has not started yet. */
function Status({ inForce, effectiveFrom, today }: { inForce: boolean; effectiveFrom: string; today: string }) {
  if (inForce) {
    return <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">In force</span>;
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
      {effectiveFrom > today ? "Not yet" : "Replaced"}
    </span>
  );
}

async function Tax() {
  const session = await requireTenant();
  if (!can(session.role, "tax.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the tax rates.</p>;
  }
  const today = todayIso(new Date());
  const { categories, rates, rules } = await listTaxTables(session, today);
  const canManage = can(session.role, "tax.manage");
  // One entry per rule, however many dated rows it has (the rows arrive newest first).
  const ruleChoices = rules.filter((rule, index) => rules.findIndex((other) => other.code === rule.code) === index);

  return (
    <div className="flex flex-col gap-5">
      <Card title="Sales tax">
        <p className="mb-2 text-sm text-muted-foreground">
          An item belongs to a category. The rate charged is the category&apos;s rate on the date of the document, so a
          document dated before a change keeps the old rate.
        </p>
        {categories.length === 0 ? (
          <Empty>No tax categories yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Sales tax rates" className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 text-right font-medium">Rate</th>
                  <th className="py-2 pr-4 text-right font-medium">Further tax</th>
                  <th className="py-2 pr-4 font-medium">Law or SRO</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {categories.flatMap((category) =>
                  rates
                    .filter((rate) => rate.categoryId === category.id)
                    .map((rate) => (
                      <tr key={rate.id}>
                        <td className="py-2 pr-4">
                          <span className="font-medium">{category.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[TAX_CATEGORY_KIND_LABELS[category.kind], category.sroScheduleNo, category.sroItemSerial]
                              .filter((part) => part && part !== category.name)
                              .join(" · ")}
                          </span>
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(rate.effectiveFrom)}</td>
                        <td className="py-2 pr-4 text-right whitespace-nowrap">{formatPercent(rate.rate)}</td>
                        <td className="py-2 pr-4 text-right whitespace-nowrap">
                          {rate.furtherTaxRate.isZero() ? "None" : formatPercent(rate.furtherTaxRate)}
                        </td>
                        <td className="py-2 pr-4">{rate.legalReference}</td>
                        <td className="py-2 whitespace-nowrap">
                          <Status inForce={rate.inForce} effectiveFrom={rate.effectiveFrom} today={today} />
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Withholding">
        <p className="mb-2 text-sm text-muted-foreground">
          What {session.tenantName} deducts when it pays a supplier, and the provincial sales tax on services. Each
          rate applies from its date until the next one.
        </p>
        {rules.length === 0 ? (
          <Empty>No withholding rules yet.</Empty>
        ) : (
          WITHHOLDING_KINDS.filter((kind) => rules.some((rule) => rule.kind === kind)).map((kind) => (
            <div key={kind} className="mt-4 overflow-x-auto first:mt-0">
              <table aria-label={WITHHOLDING_KIND_LABELS[kind]} className="w-full min-w-[860px] text-left text-sm">
                <caption className="pb-1 text-left text-sm font-bold">{WITHHOLDING_KIND_LABELS[kind]}</caption>
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Rule</th>
                    <th className="py-2 pr-4 font-medium">From</th>
                    <th className="py-2 pr-4 text-right font-medium">Rate</th>
                    {kind === "income_tax" ? <th className="py-2 pr-4 text-right font-medium">Not on the ATL</th> : null}
                    <th className="py-2 pr-4 font-medium">Taken of</th>
                    <th className="py-2 pr-4 font-medium">Law or SRO</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rules
                    .filter((rule) => rule.kind === kind)
                    .map((rule) => (
                      <tr key={rule.id}>
                        <td className="py-2 pr-4 font-medium">{rule.label}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(rule.effectiveFrom)}</td>
                        <td className="py-2 pr-4 text-right whitespace-nowrap">{formatPercent(rule.rate)}</td>
                        {kind === "income_tax" ? (
                          <td className="py-2 pr-4 text-right whitespace-nowrap">
                            {rule.rateNonAtl === null ? "Not set" : formatPercent(rule.rateNonAtl)}
                          </td>
                        ) : null}
                        <td className="py-2 pr-4">{WITHHOLDING_BASE_LABELS[rule.base]}</td>
                        <td className="py-2 pr-4">{rule.legalReference}</td>
                        <td className="py-2 whitespace-nowrap">
                          <Status inForce={rule.inForce} effectiveFrom={rule.effectiveFrom} today={today} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Card>

      {canManage ? (
        <>
          <p className="text-sm text-muted-foreground">
            A new rate starts on its date and leaves earlier dates as they were. Saving a second rate for the same date
            replaces the first; the activity log keeps both.
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Change a sales tax rate" className="min-w-0">
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add a category first.</p>
              ) : (
                <ActionForm action={setTaxRateAction} submitLabel="Save sales tax rate">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="rate-category">Category</Label>
                    <select id="rate-category" name="categoryId" required defaultValue="" className={SELECT}>
                      <option value="" disabled>
                        Choose a category
                      </option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Field id="rate-from" label="From date" name="effectiveFrom" type="date" defaultValue={today} required />
                  <Field id="rate-rate" label="Rate %" name="rate" inputMode="decimal" required autoComplete="off" hint="Such as 18 or 5.5." />
                  <Field
                    id="rate-further"
                    label="Further tax %"
                    name="furtherTaxRate"
                    inputMode="decimal"
                    required
                    autoComplete="off"
                    hint="Charged on top when the buyer is not registered for sales tax or is not an active taxpayer. Enter 0 for none."
                  />
                  <Field id="rate-law" label="Law or SRO" name="legalReference" required maxLength={160} hint={LAW_HINT} />
                </ActionForm>
              )}
            </Card>

            <Card title="Add a category" className="min-w-0">
              <ActionForm action={addTaxCategoryAction} submitLabel="Add category">
                <Field id="category-name" label="Name" name="name" required maxLength={60} hint="Such as Reduced rate 10%." />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="category-kind">Kind</Label>
                  <select id="category-kind" name="kind" required defaultValue="reduced" className={SELECT}>
                    {TAX_CATEGORY_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {TAX_CATEGORY_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <Field
                  id="category-schedule"
                  label="Schedule or SRO"
                  name="sroScheduleNo"
                  maxLength={60}
                  hint="Needed for a reduced rate, such as Eighth Schedule."
                />
                <Field id="category-serial" label="Serial in the schedule" name="sroItemSerial" maxLength={60} />
                <Field id="category-from" label="From date" name="effectiveFrom" type="date" defaultValue={today} required />
                <Field
                  id="category-rate"
                  label="Rate %"
                  name="rate"
                  inputMode="decimal"
                  required
                  autoComplete="off"
                  hint="0 for an exempt or zero-rated category."
                />
                <Field
                  id="category-further"
                  label="Further tax %"
                  name="furtherTaxRate"
                  inputMode="decimal"
                  required
                  autoComplete="off"
                  hint="Enter 0 for none."
                />
                <Field id="category-law" label="Law or SRO" name="legalReference" required maxLength={160} hint={LAW_HINT} />
              </ActionForm>
            </Card>

            <Card title="Change a withholding rate" className="min-w-0">
              {ruleChoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">There are no withholding rules.</p>
              ) : (
                <ActionForm action={setWithholdingRateAction} submitLabel="Save withholding rate">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="rule-code">Rule</Label>
                    <select id="rule-code" name="code" required defaultValue="" className={SELECT}>
                      <option value="" disabled>
                        Choose a rule
                      </option>
                      {WITHHOLDING_KINDS.map((kind) => (
                        <optgroup key={kind} label={WITHHOLDING_KIND_LABELS[kind]}>
                          {ruleChoices
                            .filter((rule) => rule.kind === kind)
                            .map((rule) => (
                              <option key={rule.code} value={rule.code}>
                                {rule.label}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <Field id="rule-from" label="From date" name="effectiveFrom" type="date" defaultValue={today} required />
                  <Field id="rule-rate" label="Rate %" name="rate" inputMode="decimal" required autoComplete="off" />
                  <Field
                    id="rule-non-atl"
                    label="Rate % when not on the ATL"
                    name="rateNonAtl"
                    inputMode="decimal"
                    autoComplete="off"
                    hint="Income tax rules only: the rate for a supplier who is not on the Active Taxpayers List, normally double. Leave empty for the other rules."
                  />
                  <Field id="rule-law" label="Law or SRO" name="legalReference" required maxLength={160} hint={LAW_HINT} />
                </ActionForm>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
