import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { getReceivablesInBooks, listCustomerAgeing } from "@/modules/recovery/queries";
import { ageingTable } from "@/modules/recovery/rules";
import { can } from "@/modules/tenant/rules";
import { ReportTableView } from "../../../(app)/reports/_parts/report-table";

export const metadata: Metadata = { title: "Aged receivables" };

export default function PrintAgeingPage() {
  return (
    <main className="mx-auto w-full max-w-[1123px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintAgeing />
      </Suspense>
    </main>
  );
}

async function PrintAgeing() {
  const session = await requireTenant();
  if (!session.modules.collections || !can(session.role, "recovery.read")) notFound();
  const today = todayIso(new Date());
  const table = ageingTable(await listCustomerAgeing(session, today), today, await getReceivablesInBooks(session));
  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <Link href="/recovery/ageing" className="text-sm font-semibold text-primary hover:underline">
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
