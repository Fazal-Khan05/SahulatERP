import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { REPORTS } from "@/modules/reports/rules";
import { can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHead title="Reports" />
      <Suspense fallback={<PageLoading />}>
        <Reports />
      </Suspense>
    </>
  );
}

async function Reports() {
  const session = await requireTenant();
  if (!can(session.role, "report.read")) return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the ledger reports.</p>;
  return (
    <Card title="The books" className="max-w-2xl">
      <ul aria-label="Ledger reports" className="divide-y">
        {Object.entries(REPORTS).map(([key, report]) => (
          <li key={key} className="py-3 first:pt-0 last:pb-0">
            <Link href={`/reports/${key}`} className="font-semibold underline-offset-4 hover:underline">
              {report.title}
            </Link>
            <p className="text-sm text-muted-foreground">{report.about}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
