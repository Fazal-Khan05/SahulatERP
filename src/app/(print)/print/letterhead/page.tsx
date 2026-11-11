import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PrintButton, PrintHeader } from "@/components/print-parts";
import { requireTenant } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Letterhead" };

// A preview of the header every printed document will carry. Invoices, statements and the rest
// arrive with their own steps and reuse PrintHeader.
export default function LetterheadPage() {
  return (
    <main className="mx-auto w-full max-w-[794px] flex-1 bg-white p-10 max-sm:p-5 print:p-0">
      <Suspense fallback={<PageLoading />}>
        <Letterhead />
      </Suspense>
    </main>
  );
}

async function Letterhead() {
  const session = await requireTenant();
  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
        <Link href="/settings" className="text-sm font-semibold text-primary hover:underline">
          Back to settings
        </Link>
        <PrintButton />
      </div>
      <PrintHeader
        companyName={session.tenantName}
        productName={session.branding.productName}
        logoUrl={session.branding.logoUrl}
      />
      <p className="mt-8 text-sm text-muted-foreground">
        Every printed document from {session.tenantName} starts with this header. The document itself goes here.
      </p>
    </>
  );
}
