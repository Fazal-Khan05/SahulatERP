import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDay } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { getCompanySetup } from "@/modules/setup/queries";
import { ROLE_LABELS, can } from "@/modules/tenant/rules";
import { OwnerFigures } from "./_home/owner-figures";

export const metadata: Metadata = { title: "Home" };

// Each role's home fills in as its modules are built: who you are, where you are, and what is
// waiting on you. The owner's also has the business's figures for a period (Step 36).
export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Home searchParams={searchParams} />
    </Suspense>
  );
}

async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, raw] = await Promise.all([requireTenant(), searchParams]);
  const setup = await getCompanySetup(session);
  return (
    <>
      <PageHead title="Home" sub={formatDay(new Date())} />
      <p className="mb-4 text-muted-foreground">
        Signed in as {session.email}, {ROLE_LABELS[session.role]} at {session.tenantName}.
      </p>
      {setup === null ? (
        <Card title="Finish setting up" className="mb-5">
          {can(session.role, "setup.complete") ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">A few questions about {session.tenantName}, asked once: sales tax, currency, fiscal year and what the company will use.</p>
              <Link href="/setup" className={buttonVariants({ size: "sm" })}>
                Set up {session.tenantName}
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">The owner has not finished setting up {session.tenantName} yet.</p>
          )}
        </Card>
      ) : null}
      {setup !== null && session.role === "owner" && can(session.role, "report.read") ? <OwnerFigures session={session} raw={raw} /> : null}
      <Card title="Needs attention">
        <Empty>Nothing needs your attention.</Empty>
        <p className="text-center text-sm">
          <Link href="/inbox" className="font-semibold text-primary hover:underline">
            Open the list
          </Link>
        </p>
      </Card>
    </>
  );
}
