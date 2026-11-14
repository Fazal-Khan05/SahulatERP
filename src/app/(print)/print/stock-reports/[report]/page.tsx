import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { getStockReport } from "@/modules/stock-reports/queries";
import { STOCK_REPORTS, isStockReportKey, stockFilterQuery } from "@/modules/stock-reports/rules";
import { can } from "@/modules/tenant/rules";
import { ReportTableView } from "../../../../(app)/reports/_parts/report-table";
import { loadStockFilter } from "../../../../(app)/stock-reports/_parts/load";

export const metadata: Metadata = { title: "Stock report" };

// A stock report on the company's letterhead, for the printer or for saving as a PDF.
export default function PrintStockReportPage({ params, searchParams }: PageProps<"/print/stock-reports/[report]">) {
  return (
    <main className="mx-auto w-full max-w-[1123px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintStockReport params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function PrintStockReport({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isStockReportKey(report) || !session.modules.inventory || !can(session.role, STOCK_REPORTS[report].permission)) notFound();
  const filter = await loadStockFilter(session, raw);
  const table = await getStockReport(session, report, filter, todayIso(new Date()));
  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/stock-reports/${report}?${stockFilterQuery(filter)}`} className="text-sm font-semibold text-primary hover:underline">
          Back to the report
        </Link>
        <PrintButton />
      </div>
      <PrintHeader companyName={session.tenantName} productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <h1 className="mt-6 text-xl font-bold">{table.title}</h1>
      <p className="mb-4 text-sm text-muted-foreground" data-testid="report-period">
        {table.period}
      </p>
      <ReportTableView table={table} />
      <p className="mt-6 text-xs text-muted-foreground">Printed {formatDateTime(new Date())}</p>
    </>
  );
}
