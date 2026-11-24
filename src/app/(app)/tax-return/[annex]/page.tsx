import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { getTaxReturn } from "@/modules/tax-return/queries";
import { ANNEXES, annexTable, isAnnexKey, readReturnPeriod } from "@/modules/tax-return/rules";
import { ReportTableView } from "../../reports/_parts/report-table";
import { openReturn } from "../_parts/load";

export const metadata: Metadata = { title: "Sales tax return annex" };

export default function AnnexPage({ params, searchParams }: PageProps<"/tax-return/[annex]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Annex params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Annex({ params, searchParams }: Pick<PageProps<"/tax-return/[annex]">, "params" | "searchParams">) {
  const session = await requireTenant();
  const [{ annex }, raw] = await Promise.all([params, searchParams]);
  if (!isAnnexKey(annex)) notFound();
  const about = ANNEXES[annex];
  const period = readReturnPeriod(raw.month, todayIso(new Date()));
  const back = (
    <p className="mb-2 text-sm">
      <Link href={`/tax-return?month=${period.month}`} className="text-muted-foreground underline-offset-4 hover:underline">
        Sales tax return
      </Link>
    </p>
  );
  const opened = await openReturn(session);
  if ("refused" in opened) {
    return (
      <>
        {back}
        <PageHead title={about.title} />
        <p className="text-muted-foreground">{opened.refused}</p>
      </>
    );
  }
  const table = annexTable(await getTaxReturn(session, period), annex);
  const file = (format: string) => `/tax-return/export?annex=${annex}&month=${period.month}&format=${format}`;

  return (
    <>
      {back}
      <PageHead title={about.title} sub={about.about} />
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" data-testid="report-period">
            {table.period}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={file("xlsx")} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Download Excel
            </a>
            <a href={file("csv")} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Download CSV
            </a>
          </div>
        </div>
        {table.rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to list for {table.period}.</p> : null}
        <ReportTableView table={table} />
      </Card>
    </>
  );
}
