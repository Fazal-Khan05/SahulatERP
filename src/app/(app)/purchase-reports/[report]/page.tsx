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
import { getPurchaseReport, listPurchaseReportChoices } from "@/modules/purchase-reports/queries";
import { PURCHASE_REPORTS, isPurchaseReportKey, purchaseFilterQuery } from "@/modules/purchase-reports/rules";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { ReportTableView } from "../../reports/_parts/report-table";
import { loadPurchaseFilter } from "../_parts/load";

export const metadata: Metadata = { title: "Buying report" };

export default function PurchaseReportPage({ params, searchParams }: PageProps<"/purchase-reports/[report]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PurchaseReport params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

async function PurchaseReport({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const [{ report }, raw] = await Promise.all([params, searchParams]);
  if (!isPurchaseReportKey(report)) notFound();
  const about = PURCHASE_REPORTS[report];
  const refused = !session.modules.purchasing ? "Purchasing is switched off for this company." : !can(session.role, about.permission) ? "Only an owner, an accountant or an auditor can see what is owed to suppliers." : null;
  if (refused) {
    return (
      <>
        <PageHead title={about.title} />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const [filter, branches, choices] = await Promise.all([loadPurchaseFilter(session, raw), listBranches(session), listPurchaseReportChoices(session)]);
  const table = await getPurchaseReport(session, report, filter);
  const mine = branches.filter((branch) => seesBranch(session.branchIds, branch.id));
  const query = (extra: Record<string, string> = {}) => purchaseFilterQuery(filter, extra);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/reports" className="text-muted-foreground underline-offset-4 hover:underline">
          Reports
        </Link>
      </p>
      <PageHead title={about.title} sub={about.about} />
      <div className="flex max-w-6xl flex-col gap-5">
        {about.dated ? (
          <Card>
            {/* A plain form: what was asked for travels in the address, so a report can be bookmarked, printed and downloaded as shown. */}
            <form method="get" className="flex flex-wrap items-end gap-3">
              {about.period ? <Field label="From" name="from" type="date" defaultValue={filter.from} required /> : null}
              <Field label={about.period ? "To" : "As at the end of"} name="to" type="date" defaultValue={filter.to} required />
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
              {about.bySupplier ? (
                <div className="flex min-w-56 flex-col gap-1.5">
                  <Label htmlFor="supplier">Supplier</Label>
                  <select id="supplier" name="supplier" defaultValue={filter.supplierId ?? ""} className={SELECT}>
                    <option value="">{report === "supplier-statement" ? "Choose a supplier" : "Every supplier"}</option>
                    {choices.suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <Button type="submit">Show</Button>
            </form>
          </Card>
        ) : null}

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="report-period">
              {table.period}
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={`/purchase-reports/export?${query({ report, format: "xlsx" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download Excel
              </a>
              <a href={`/purchase-reports/export?${query({ report, format: "csv" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download CSV
              </a>
              <Link href={`/print/purchase-reports/${report}?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
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
