import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { PROVINCES, PROVINCE_LABELS } from "@/modules/parties/rules";
import { getTaxReturn } from "@/modules/tax-return/queries";
import { ANNEXES, ANNEX_KEYS, annexCProblems, groupH1, neighbouringMonths, readReturnPeriod, reconcile, type AnnexKey, type TaxReturn } from "@/modules/tax-return/rules";
import { can } from "@/modules/tenant/rules";
import { setProvinceAction } from "./actions";
import { openReturn } from "./_parts/load";

export const metadata: Metadata = { title: "Sales tax return" };

export default function TaxReturnPage({ searchParams }: PageProps<"/tax-return">) {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/reports" className="text-muted-foreground underline-offset-4 hover:underline">
          Reports
        </Link>
      </p>
      <PageHead title="Sales tax return" sub="The month's annexes for FBR, read from what was posted and set beside the ledger." />
      <Suspense fallback={<PageLoading />}>
        <TaxReturnView searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const rowsIn = (data: TaxReturn, key: AnnexKey) => (key === "annex-c" ? data.c.length : key === "annex-c1" ? data.c1.length : key === "annex-a" ? data.a.length : key === "annex-b" ? data.b.length : groupH1(data.h1).length);

async function TaxReturnView({ searchParams }: Pick<PageProps<"/tax-return">, "searchParams">) {
  const session = await requireTenant();
  const opened = await openReturn(session);
  if ("refused" in opened) return <p className="text-muted-foreground">{opened.refused}</p>;
  const { standing } = opened;
  const period = readReturnPeriod((await searchParams).month, todayIso(new Date()));
  const data = await getTaxReturn(session, period);
  const lines = reconcile(data);
  const problems = annexCProblems(data.c, data.province);
  const { previous, next } = neighbouringMonths(period);

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-4">
          {/* A plain form: the month travels in the address, so the page can be bookmarked. */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Month" name="month" type="month" defaultValue={period.month} required />
            <Button type="submit">Show</Button>
            <Link href={`/tax-return?month=${previous}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Month before
            </Link>
            <Link href={`/tax-return?month=${next}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Month after
            </Link>
          </form>
          <p className="text-sm text-muted-foreground">
            STRN {standing.strn ?? "not set"} · NTN {standing.ntn ?? "not set"}
          </p>
        </div>
      </Card>

      <Card title={`The annexes for ${period.label}`}>
        <div className="overflow-x-auto">
          <table aria-label="Annexes" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Annex</th>
                <th scope="col" className="py-2 pr-4 font-medium">What it lists</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Rows</th>
                <th scope="col" className="py-2 font-medium">File for upload</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ANNEX_KEYS.map((key) => (
                <tr key={key}>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    <Link href={`/tax-return/${key}?month=${period.month}`} className="underline underline-offset-4">
                      {ANNEXES[key].title}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">{ANNEXES[key].about}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{rowsIn(data, key)}</td>
                  <td className="py-2 whitespace-nowrap">
                    <a href={`/tax-return/export?annex=${key}&month=${period.month}&format=xlsx`} className="underline underline-offset-4">
                      Excel
                    </a>{" "}
                    ·{" "}
                    <a href={`/tax-return/export?annex=${key}&month=${period.month}&format=csv`} className="underline underline-offset-4">
                      CSV
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problems.map((problem) => (
          <p key={problem} data-testid="return-problem" className="mt-3 text-sm text-destructive">
            {problem}
          </p>
        ))}
        <p className="mt-3 text-sm text-muted-foreground">
          The columns follow FBR&apos;s published guide. Check each file against the template downloaded from IRIS before the first return is filed from it.
        </p>
      </Card>

      <Card title="Beside the ledger">
        <p className="mb-2 text-sm text-muted-foreground">
          Each annex adds up what was posted; the ledger is what the same documents&apos; journals put on the tax account in {period.label}. Other entries are anything else
          on that account in the month, such as a journal written by hand, which the return must explain too.
        </p>
        <div className="overflow-x-auto">
          <table aria-label="Beside the ledger" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">What</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Annex</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Ledger</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Other entries</th>
                <th scope="col" className="py-2 font-medium">Agrees</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.label} data-agrees={line.agrees ? "yes" : "no"}>
                  <td className="py-2 pr-4">{line.label}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(line.annex)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(line.ledger)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{line.other.isZero() ? "" : formatAmount(line.other)}</td>
                  <td className={`py-2 ${line.agrees ? "" : "font-semibold text-destructive"}`}>{line.agrees ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Province of supply">
        {can(session.role, "tax_return.settings") ? (
          <ActionForm action={setProvinceAction} submitLabel="Save" compact>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="province">The province the company supplies from</Label>
              <select id="province" name="province" defaultValue={standing.province ?? ""} required className={SELECT}>
                <option value="" disabled>
                  Choose a province
                </option>
                {PROVINCES.map((province) => (
                  <option key={province} value={province}>
                    {PROVINCE_LABELS[province]}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm" data-testid="return-province">
            {standing.province ? PROVINCE_LABELS[standing.province] : "Not set. The owner or an accountant sets it."}
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">Annex-C names it on every line as the province the sale began in.</p>
      </Card>
    </div>
  );
}
