import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Needs attention" };

// The one list of things waiting on this person. It is empty until the modules that put work
// into it are built: drafts to submit, cheques to deposit, bills due, follow-ups due.
export default function InboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <InboxList />
    </Suspense>
  );
}

async function InboxList() {
  await requireTenant();
  return (
    <>
      <PageHead title="Needs attention" sub="Everything that is waiting on you, in one list." />
      <Card>
        <Empty>Nothing needs your attention.</Empty>
      </Card>
    </>
  );
}
