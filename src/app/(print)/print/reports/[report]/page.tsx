import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { LEDGER_FILE } from "@/modules/reports/queries";
import { filterQuery, isReportKey } from "@/modules/reports/rules";
import { can } from "@/modules/tenant/rules";
import { loadFilter, loadReport } from "../../../../(app)/reports/_parts/load";
import { ReportTableView } from "../../../../(app)/reports/_parts/report-table";

export const metadata: Metadata = { title: "Report" };

// A report on the company's letterhead, for the printer or for saving as a PDF.
export default function PrintReportPage({ params, searchParams }: PageProps<"/print/reports/[report]">) {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintReport params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function PrintReport({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isReportKey(report) || !can(session.role, "report.read")) notFound();
  const filter = await loadFilter(session, raw);
  const table = await loadReport(session, report, filter, LEDGER_FILE);
  if (!table) notFound();
  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/reports/${report}?${filterQuery(filter)}`} className="text-sm font-semibold text-primary hover:underline">
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
