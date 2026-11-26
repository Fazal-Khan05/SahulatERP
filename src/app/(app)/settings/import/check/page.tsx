import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getImportState, getOpeningCheck } from "@/modules/data-import/queries";
import { can } from "@/modules/tenant/rules";
import { ReportTableView } from "../../../reports/_parts/report-table";

export const metadata: Metadata = { title: "Check what came in" };

export default function ImportCheckPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ImportCheck />
    </Suspense>
  );
}

async function ImportCheck() {
  const session = await requireTenant();
  if (!can(session.role, "opening.manage")) {
    return <p className="text-muted-foreground">Only an owner or an accountant can import a company&apos;s data.</p>;
  }
  const state = await getImportState(session);
  const check = await getOpeningCheck(session, todayIso(new Date()), state);
  const agreed = check.agreements.every((agreement) => agreement.difference.isZero());

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <Link href="/settings/import" className="text-sm underline">
        Back to Import data
      </Link>

      {check.waiting.length > 0 ? (
        <Card title="Still to do">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="import-waiting">
            {check.waiting.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={`Against the books, as at ${formatIsoDate(check.asAt)}`}>
        <p className={`mb-3 text-sm font-semibold ${agreed ? "" : "text-destructive"}`} data-testid="import-agreement">
          {agreed
            ? "Each agrees with its account in the books."
            : "Something does not agree with its account in the books: an entry made to that account by hand would do this. Open the report beside it to see where."}
        </p>
        <div className="overflow-x-auto">
          <table aria-label="Against the books" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">What</th>
                <th className="py-2 pr-4 text-right font-medium">Its own records</th>
                <th className="py-2 pr-4 text-right font-medium">In the books</th>
                <th className="py-2 pr-4 text-right font-medium">Difference</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {check.agreements.map((agreement) => (
                <tr key={agreement.what} data-agrees={agreement.difference.isZero()}>
                  <td className="py-2 pr-4">{agreement.title}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(agreement.records)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(agreement.books)}</td>
                  <td className={`py-2 pr-4 text-right tabular-nums ${agreement.difference.isZero() ? "" : "font-semibold text-destructive"}`}>{formatAmount(agreement.difference)}</td>
                  <td className="py-2">
                    <Link href={agreement.href} className="underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={check.trialBalance.title}>
        <p className="mb-3 text-sm text-muted-foreground">
          {check.trialBalance.period}. It should match the trial balance of your old system on the day the books opened here, account for account, once every
          file is in and posted.
        </p>
        <ReportTableView table={check.trialBalance} />
        {check.trialBalance.notes.map((note) => (
          <p key={note} className="mt-2 text-sm text-destructive">
            {note}
          </p>
        ))}
      </Card>
    </div>
  );
}
