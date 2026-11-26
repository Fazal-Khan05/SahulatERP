import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { getReceivablesInBooks, listCustomerAgeing } from "@/modules/recovery/queries";
import { ageingTable } from "@/modules/recovery/rules";
import { ReportTableView } from "../../reports/_parts/report-table";
import { Refused, Sections, recoveryRefusal } from "../_parts/parts";

export const metadata: Metadata = { title: "Aged receivables" };

export default function AgeingPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Ageing />
    </Suspense>
  );
}

// What each customer owes today, by days past the due date. The overdue list is the same rows.
async function Ageing() {
  const session = await requireTenant();
  const refused = recoveryRefusal(session);
  if (refused) return <Refused title="Aged receivables" reason={refused} />;
  const today = todayIso(new Date());
  const table = ageingTable(await listCustomerAgeing(session, today), today, await getReceivablesInBooks(session));
  return (
    <>
      <PageHead title="Aged receivables" sub="What each customer owes today, by days past the due date." />
      <Sections session={session} current="/recovery/ageing" />
      <Card className="max-w-5xl">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" data-testid="report-period">
            {table.period}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="/recovery/ageing/export?format=xlsx" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Download Excel
            </a>
            <a href="/recovery/ageing/export?format=csv" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Download CSV
            </a>
            <Link href="/print/recovery-ageing" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Print
            </Link>
          </div>
        </div>
        <ReportTableView table={table} />
      </Card>
    </>
  );
}
