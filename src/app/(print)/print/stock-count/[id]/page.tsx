import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getStockCount } from "@/modules/inventory/queries";
import { formatQuantity } from "@/modules/inventory/rules";
import { can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Count sheet" };

// A stock count sheet on the company's letterhead, to take round the shelves: every item on the
// sheet with a box for what is counted. What the books say is left off on purpose, so the count
// is of the shelf and not of the list.
export default function PrintCountSheetPage({ params }: PageProps<"/print/stock-count/[id]">) {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <CountSheet params={params} />
      </Suspense>
    </main>
  );
}

async function CountSheet({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const { id } = await params;
  if (!can(session.role, "stock_count.read") || !session.modules.inventory) notFound();
  const count = await getStockCount(session, id);
  if (!count) notFound();
  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/stock/counts/${count.id}`} className="text-sm font-semibold text-primary hover:underline">
          Back to the count
        </Link>
        <PrintButton />
      </div>
      <PrintHeader companyName={session.tenantName} productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <h1 className="mt-6 text-xl font-bold">Stock count sheet{count.number ? ` ${count.number}` : ""}</h1>
      <p className="mb-4 text-sm text-muted-foreground" data-testid="sheet-head">
        {count.warehouse}, {formatIsoDate(count.date)}
        {count.note ? `. ${count.note}` : ""}
      </p>
      <table aria-label="Count sheet" className="w-full text-left text-sm">
        <thead className="border-b-2 border-foreground">
          <tr>
            <th className="py-2 pr-4 font-semibold">Item code</th>
            <th className="py-2 pr-4 font-semibold">Item</th>
            <th className="py-2 pr-4 font-semibold">Unit</th>
            <th className="w-40 py-2 text-right font-semibold">Counted</th>
          </tr>
        </thead>
        <tbody>
          {count.lines.map((line) => (
            <tr key={line.id} className="border-b">
              <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.code}</td>
              <td className="py-2 pr-4">{line.name}</td>
              <td className="py-2 pr-4">{line.unit}</td>
              <td className="py-2 text-right tabular-nums">{count.status === "draft" || line.counted === null ? "" : formatQuantity(line.counted)}</td>
            </tr>
          ))}
          {/* Room for what is found on the shelf and is not on the sheet. */}
          {count.status === "draft"
            ? [1, 2, 3, 4].map((blank) => (
                <tr key={blank} className="border-b">
                  <td className="py-4" colSpan={4} />
                </tr>
              ))
            : null}
        </tbody>
      </table>
      <p className="mt-10 text-sm">Counted by: ______________________ &nbsp; Checked by: ______________________</p>
      <p className="mt-6 text-xs text-muted-foreground">Printed {formatDateTime(new Date())}</p>
    </>
  );
}
