import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { requireTenant } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "SahulatERP" };

// A placeholder home. The role home screens and the inbox are Step 3.
// The session and the rows are read at request time, behind the boundary, so moving between
// pages shows the frame at once and the content as soon as it is ready.
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
    <section className="flex flex-col gap-2">
      <h1 className="text-xl font-medium">{session.tenantName}</h1>
      <p className="text-sm text-muted-foreground">
        Signed in as {session.email}, {ROLE_LABELS[session.role]}.
      </p>
    </section>
  );
}
