import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getPrintableDocument } from "@/modules/sales-print/queries";
import { printView } from "@/modules/sales-print/view";
import { SalesPrintBody } from "./body";

export const metadata: Metadata = { title: "Print" };

// A sales document on the company's letterhead, for the printer. The PDF of the same is beside it.
export default function PrintSalesDocumentPage({ params }: PageProps<"/print/sales/[id]">) {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintSalesDocument params={params} />
      </Suspense>
    </main>
  );
}

async function PrintSalesDocument({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const { id } = await params;
  if (!session.modules.sales) notFound();
  const printable = await getPrintableDocument(session, id, session.tenantName);
  if (!printable) notFound();
  const view = printView(printable);
  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link href={`/sales/${id}`} className="text-sm font-semibold text-primary hover:underline">
          Back to {view.number}
        </Link>
        <div className="flex gap-2">
          <a href={`/print/sales/${id}/pdf`} className={buttonVariants({ variant: "outline" })} data-testid="download-pdf">
            Download PDF
          </a>
          <PrintButton />
        </div>
      </div>
      <PrintHeader companyName={session.tenantName} productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <SalesPrintBody view={view} />
      <p className="mt-8 text-xs text-muted-foreground">
        {view.title} {view.number}, printed {formatDateTime(new Date())}
      </p>
    </>
  );
}
