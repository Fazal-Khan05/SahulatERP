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
import { todayIso } from "@/lib/format";
import { getStockReport, listStockReportChoices } from "@/modules/stock-reports/queries";
import { STOCK_REPORTS, isStockReportKey, stockFilterQuery } from "@/modules/stock-reports/rules";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { ReportTableView } from "../../reports/_parts/report-table";
import { loadStockFilter } from "../_parts/load";

export const metadata: Metadata = { title: "Stock report" };

export default function StockReportPage({ params, searchParams }: PageProps<"/stock-reports/[report]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <StockReport params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

async function StockReport({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isStockReportKey(report)) notFound();
  const about = STOCK_REPORTS[report];
  const refused = !session.modules.inventory ? "Stock is switched off for this company." : !can(session.role, about.permission) ? (about.permission === "stock.read" ? "Your role does not include stock." : "Only an owner, an accountant or an auditor can see what stock cost.") : null;
  if (refused) {
    return (
      <>
        <PageHead title={about.title} />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const today = todayIso(new Date());
  const [filter, branches, choices] = await Promise.all([loadStockFilter(session, raw), listBranches(session), listStockReportChoices(session)]);
  const table = await getStockReport(session, report, filter, today);
  const mine = branches.filter((branch) => seesBranch(session.branchIds, branch.id));
  const query = (extra: Record<string, string> = {}) => stockFilterQuery(filter, extra);
  const dated = report !== "low-stock";
  const byWarehouse = report === "valuation" || report === "movement" || report === "ageing";

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
            {about.period ? <Field label="From" name="from" type="date" defaultValue={filter.from} required /> : null}
            {dated ? <Field label={about.period ? "To" : "As at the end of"} name="to" type="date" defaultValue={filter.to} required /> : null}
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
            {byWarehouse ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="warehouse">Warehouse</Label>
                <select id="warehouse" name="warehouse" defaultValue={filter.warehouseId ?? ""} className={SELECT}>
                  <option value="">Every warehouse</option>
                  {choices.warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {report === "movement" ? (
              <div className="flex min-w-56 flex-col gap-1.5">
                <Label htmlFor="item">Item</Label>
                <select id="item" name="item" defaultValue={filter.itemId ?? ""} className={SELECT}>
                  <option value="">Every item, in total</option>
                  {choices.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
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
              <a href={`/stock-reports/export?${query({ report, format: "xlsx" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download Excel
              </a>
              <a href={`/stock-reports/export?${query({ report, format: "csv" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download CSV
              </a>
              <Link href={`/print/stock-reports/${report}?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
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
