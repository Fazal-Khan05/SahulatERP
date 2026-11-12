import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { listCurrencies, listRates } from "@/modules/currencies/queries";
import { formatIsoDate, formatRate } from "@/modules/currencies/rules";
import { can } from "@/modules/tenant/rules";
import { addCurrencyAction, setBaseCurrencyAction, setRateAction } from "../actions";

export const metadata: Metadata = { title: "Currencies" };

export default function CurrenciesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Currencies />
    </Suspense>
  );
}

async function Currencies() {
  const session = await requireTenant();
  if (!can(session.role, "currency.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the currencies.</p>;
  }
  const [currencies, rates] = await Promise.all([listCurrencies(session), listRates(session)]);
  const base = currencies.find((c) => c.isBase);
  const foreign = currencies.filter((c) => !c.isBase);
  const canManage = can(session.role, "currency.manage");

  // Nothing else makes sense until the company has said which currency its books are kept in.
  if (!base) {
    return (
      <Card title="Base currency" className="max-w-xl">
        <p className="mb-4 text-sm text-muted-foreground">
          The currency {session.tenantName} keeps its books in. Every amount is stored in it, so it is chosen once
          and cannot be changed afterwards.
        </p>
        {can(session.role, "currency.set_base") ? (
          <ActionForm action={setBaseCurrencyAction} submitLabel="Set base currency">
            <Field label="Code" name="code" defaultValue="PKR" required maxLength={3} hint="Three letters, such as PKR." />
            <Field label="Name" name="name" defaultValue="Pakistani Rupee" required maxLength={60} />
          </ActionForm>
        ) : (
          <p className="text-sm">The owner has not chosen the base currency yet.</p>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card title="Currencies">
        <p className="mb-2 text-sm text-muted-foreground">
          The books of {session.tenantName} are kept in {base.name} ({base.code}). A rate says how many {base.code} one
          unit of the other currency is worth, from its date until the next rate.
        </p>
        <div className="overflow-x-auto">
          <table aria-label="Currencies" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Code</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 text-right font-medium">Latest rate</th>
                <th className="py-2 font-medium">From</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {currencies.map((currency) => (
                <tr key={currency.id}>
                  <td className="py-2 pr-4 font-medium">{currency.code}</td>
                  <td className="py-2 pr-4">{currency.name}</td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap">
                    {currency.isBase ? "Base currency" : currency.latest ? formatRate(currency.latest.rate) : "No rate yet"}
                  </td>
                  <td className="py-2 whitespace-nowrap">{currency.latest ? formatIsoDate(currency.latest.date) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {canManage ? (
        <div className="grid gap-5 md:grid-cols-2">
          <Card title="Set a rate">
            {foreign.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a currency first.</p>
            ) : (
              <ActionForm action={setRateAction} submitLabel="Save rate">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="currencyId">Currency</Label>
                  <select
                    id="currencyId"
                    name="currencyId"
                    required
                    defaultValue={foreign.length === 1 ? foreign[0].id : ""}
                    className="h-8 rounded-lg border border-input bg-card px-2 text-sm"
                  >
                    <option value="" disabled>
                      Choose a currency
                    </option>
                    {foreign.map((currency) => (
                      <option key={currency.id} value={currency.id}>
                        {currency.code} · {currency.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="From date" name="date" type="date" defaultValue={todayIso(new Date())} required />
                <Field
                  label={`Rate in ${base.code}`}
                  name="rate"
                  inputMode="decimal"
                  required
                  autoComplete="off"
                  hint={`How many ${base.code} for one unit, such as 278.50. A second rate for the same day replaces the first.`}
                />
                <Field label="Source" name="source" required maxLength={60} hint="Where the rate comes from, such as the bank's name." />
              </ActionForm>
            )}
          </Card>
          <Card title="Add a currency">
            <ActionForm action={addCurrencyAction} submitLabel="Add currency">
              <Field label="Code" name="code" required maxLength={3} hint="Three letters, such as USD." />
              <Field label="Name" name="name" required maxLength={60} />
            </ActionForm>
          </Card>
        </div>
      ) : null}

      <Card title="Rates">
        {rates.length === 0 ? (
          <Empty>No rates yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Rates" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 font-medium">Currency</th>
                  <th className="py-2 pr-4 text-right font-medium">Rate in {base.code}</th>
                  <th className="py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rates.map((rate) => (
                  <tr key={rate.id}>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(rate.date)}</td>
                    <td className="py-2 pr-4 font-medium">{rate.code}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap">{formatRate(rate.rate)}</td>
                    <td className="py-2">{rate.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
