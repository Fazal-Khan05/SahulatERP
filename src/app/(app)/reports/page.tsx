import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { REPORTS } from "@/modules/reports/rules";
import { can } from "@/modules/tenant/rules";
import { reportsFor } from "@/tracks";

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

// The ledger reports, then the reports of the three tracks, each under a heading of its own. A
// track lists its reports in its own file in src/tracks; this page is not edited for them.
async function Reports() {
  const session = await requireTenant();
  const books = can(session.role, "report.read");
  const sections = reportsFor(session.role, session.modules);
  if (!books && sections.length === 0) return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the ledger reports.</p>;
  return (
    <div className="space-y-6">
      {books && (
        <Card title="The books" className="max-w-2xl">
          <ul aria-label="Ledger reports" className="divide-y">
            {Object.entries(REPORTS).map(([key, report]) => (
              <ReportRow key={key} href={`/reports/${key}`} label={report.title} about={report.about} />
            ))}
          </ul>
        </Card>
      )}
      {sections.map((section) => (
        <Card key={section.title} title={section.title} className="max-w-2xl">
          <ul aria-label={section.title} className="divide-y">
            {section.reports.map((report) => (
              <ReportRow key={report.href} href={report.href} label={report.label} about={report.about} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function ReportRow({ href, label, about }: { href: string; label: string; about: string }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <Link href={href} className="font-semibold underline-offset-4 hover:underline">
        {label}
      </Link>
      <p className="text-sm text-muted-foreground">{about}</p>
    </li>
  );
}
