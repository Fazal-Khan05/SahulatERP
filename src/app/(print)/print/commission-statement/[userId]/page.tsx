import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { canReadStatements, getCommissionStatement } from "@/modules/commission-statements/queries";
import { formatIsoDate } from "@/modules/currencies/rules";
import { readPeriod } from "@/modules/recovery/rules";
import { CommissionStatementBody } from "../../../../(app)/commissions/statements/_parts/body";

export const metadata: Metadata = { title: "Commission statement" };

// A commission statement on the company's letterhead, for the printer. Its PDF is beside it.
export default function PrintCommissionStatementPage({ params, searchParams }: PageProps<"/print/commission-statement/[userId]">) {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:max-w-none print:p-0">
      <Suspense fallback={<PageLoading />}>
        <PrintCommissionStatement params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function PrintCommissionStatement({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  if (!session.modules.commissions || !canReadStatements(session)) notFound();
  const [{ userId }, raw] = await Promise.all([params, searchParams]);
  const period = readPeriod(raw, todayIso(new Date()));
  const data = await getCommissionStatement(session, userId, period);
  if (!data) notFound();
  const query = new URLSearchParams(period).toString();
  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link href={`/commissions/statements/${userId}?${query}`} className="text-sm font-semibold text-primary hover:underline">
          Back to the statement
        </Link>
        <div className="flex gap-2">
          <a href={`/print/commission-statement/${userId}/pdf?${query}`} className={buttonVariants({ variant: "outline" })}>
            Download PDF
          </a>
          <PrintButton />
        </div>
      </div>
      <PrintHeader companyName={session.tenantName} productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <div className="mt-6 flex items-end justify-between gap-4">
        <h1 className="text-xl font-bold">Commission statement</h1>
        <p className="text-sm">
          {formatIsoDate(period.from)} to {formatIsoDate(period.to)}
        </p>
      </div>
      <p className="mt-4 mb-5 text-sm font-bold" data-testid="commission-statement-person">
        {data.person.name}
      </p>
      <CommissionStatementBody data={data} />
      <p className="mt-8 text-xs text-muted-foreground">Printed {formatDateTime(new Date())}</p>
    </>
  );
}
