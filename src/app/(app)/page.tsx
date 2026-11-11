import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { formatDay } from "@/lib/format";
import { ROLE_LABELS } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Home" };

// Each role's home fills in as its modules are built. Until then it is the same for everyone:
// who you are, where you are, and what is waiting on you.
export default function HomePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const session = await requireTenant();
  return (
    <>
      <PageHead title="Home" sub={formatDay(new Date())} />
      <p className="mb-4 text-muted-foreground">
        Signed in as {session.email}, {ROLE_LABELS[session.role]} at {session.tenantName}.
      </p>
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
