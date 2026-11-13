import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { listLedgerAccounts } from "@/modules/reports/queries";
import { REPORTS, filterQuery, isReportKey } from "@/modules/reports/rules";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { loadFilter, loadReport } from "../_parts/load";
import { ReportTableView } from "../_parts/report-table";

export const metadata: Metadata = { title: "Report" };

export default function ReportPage({ params, searchParams }: PageProps<"/reports/[report]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Report params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

async function Report({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isReportKey(report)) notFound();
  if (!can(session.role, "report.read")) {
    return (
      <>
        <PageHead title={REPORTS[report].title} />
        <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the ledger reports.</p>
      </>
    );
  }
  const ledger = report === "general-ledger";
  const oneDay = report === "balance-sheet";
  const [filter, branches, accounts] = await Promise.all([loadFilter(session, raw), listBranches(session), ledger ? listLedgerAccounts(session) : []]);
  const table = await loadReport(session, report, filter);
  const mine = branches.filter((branch) => seesBranch(session.branchIds, branch.id));
  const query = (extra: Record<string, string> = {}) => filterQuery(filter, extra);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/reports" className="text-muted-foreground underline-offset-4 hover:underline">
          Reports
        </Link>
      </p>
      <PageHead title={REPORTS[report].title} sub={REPORTS[report].about} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          {/* A plain form: the period travels in the address, so a report can be bookmarked, printed and downloaded as shown. */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            {ledger ? (
              <div className="flex min-w-56 flex-1 flex-col gap-1.5">
                <Label htmlFor="account">Account</Label>
                <select id="account" name="account" defaultValue={filter.accountId ?? ""} required className={SELECT}>
                  <option value="" disabled>
                    Choose an account
                  </option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {oneDay ? null : <Field label="From" name="from" type="date" defaultValue={filter.from} required />}
            <Field label={oneDay ? "As at the end of" : "To"} name="to" type="date" defaultValue={filter.to} required />
            {mine.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch">Branch</Label>
                <select id="branch" name="branch" defaultValue={filter.branchId ?? ""} className={SELECT}>
                  <option value="">{session.branchIds === null ? "Whole company" : "All my branches"}</option>
                  {mine.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Button type="submit">Show</Button>
          </form>
        </Card>

        {table ? (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground" data-testid="report-period">
                {table.period}
              </p>
              <div className="flex flex-wrap gap-2">
                <a href={`/reports/export?${query({ report, format: "xlsx" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Download Excel
                </a>
                <a href={`/reports/export?${query({ report, format: "csv" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Download CSV
                </a>
                <Link href={`/print/reports/${report}?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Print
                </Link>
              </div>
            </div>
            <ReportTableView table={table} />
          </Card>
        ) : (
          <Card>
            <p className="py-6 text-center text-muted-foreground">Choose an account to see its entries.</p>
          </Card>
        )}
      </div>
    </>
  );
}
