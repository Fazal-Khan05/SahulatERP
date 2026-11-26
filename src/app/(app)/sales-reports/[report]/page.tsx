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
import { getSalesReport } from "@/modules/sales-reports/queries";
import { SALES_REPORTS, SALES_REPORT_PERMISSION, isSalesReportKey, salesFilterQuery } from "@/modules/sales-reports/rules";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { ReportTableView } from "../../reports/_parts/report-table";
import { loadSalesFilter } from "../_parts/load";

export const metadata: Metadata = { title: "Sales report" };

export default function SalesReportPage({ params, searchParams }: PageProps<"/sales-reports/[report]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <SalesReport params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

async function SalesReport({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isSalesReportKey(report)) notFound();
  const about = SALES_REPORTS[report];
  const refused = !session.modules.sales ? "Sales is switched off for this company." : !can(session.role, SALES_REPORT_PERMISSION) ? "Only an owner, an accountant, an auditor or the sales manager can see the sales reports." : null;
  if (refused) {
    return (
      <>
        <PageHead title={about.title} />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const [filter, branches] = await Promise.all([loadSalesFilter(session, raw), listBranches(session)]);
  const table = await getSalesReport(session, report, filter);
  const mine = branches.filter((branch) => seesBranch(session.branchIds, branch.id));
  const query = (extra: Record<string, string> = {}) => salesFilterQuery(filter, extra);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/reports" className="text-muted-foreground underline-offset-4 hover:underline">
          Reports
        </Link>
      </p>
      <PageHead title={about.title} sub={about.about} />
      <div className="flex max-w-6xl flex-col gap-5">
        <Card>
          {/* A plain form: what was asked for travels in the address, so a report can be bookmarked, printed and downloaded as shown. */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="From" name="from" type="date" defaultValue={filter.from} required />
            <Field label="To" name="to" type="date" defaultValue={filter.to} required />
            {mine.length > 1 ? (
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

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="report-period">
              {table.period}
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={`/sales-reports/export?${query({ report, format: "xlsx" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download Excel
              </a>
              <a href={`/sales-reports/export?${query({ report, format: "csv" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download CSV
              </a>
              <Link href={`/print/sales-reports/${report}?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Print
              </Link>
            </div>
          </div>
          <ReportTableView table={table} />
        </Card>
      </div>
    </>
  );
}
