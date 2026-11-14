import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getCustomerStatement } from "@/modules/recovery/queries";
import { readPeriod } from "@/modules/recovery/rules";
import { can } from "@/modules/tenant/rules";
import { StatementBody } from "../../../../(app)/recovery/_parts/parts";

export const metadata: Metadata = { title: "Statement" };

// A customer statement on the company's letterhead, for the printer. Its PDF is beside it.
export default function PrintStatementPage({ params, searchParams }: PageProps<"/print/statement/[id]">) {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintStatement params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function PrintStatement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  if (!session.modules.collections || !can(session.role, "recovery.read")) notFound();
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  const period = readPeriod(raw, todayIso(new Date()));
  const data = await getCustomerStatement(session, id, period);
  if (!data) notFound();
  const query = new URLSearchParams(period).toString();
  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link href={`/recovery/statements?customer=${id}&${query}`} className="text-sm font-semibold text-primary hover:underline">
          Back to the statement
        </Link>
        <div className="flex gap-2">
          <a href={`/print/statement/${id}/pdf?${query}`} className={buttonVariants({ variant: "outline" })}>
            Download PDF
          </a>
          <PrintButton />
        </div>
      </div>
      <PrintHeader companyName={session.tenantName} productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <div className="mt-6 flex items-end justify-between gap-4">
        <h1 className="text-xl font-bold">Statement of account</h1>
        <p className="text-sm">
          {formatIsoDate(period.from)} to {formatIsoDate(period.to)}
        </p>
      </div>
      <div className="mt-4 mb-5 text-sm">
        <p className="font-bold" data-testid="statement-customer">
          {data.customer.name}
        </p>
        {data.customer.address ? <p>{data.customer.address}</p> : null}
        {data.customer.ntn ? <p>NTN {data.customer.ntn}</p> : null}
      </div>
      <StatementBody data={data} />
      <p className="mt-8 text-xs text-muted-foreground">Printed {formatDateTime(new Date())}</p>
    </>
  );
}
