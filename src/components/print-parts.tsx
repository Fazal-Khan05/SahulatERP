"use client";

import { Button } from "@/components/ui/button";

type HeaderProps = { companyName: string; productName: string; logoUrl: string | null };

/** The top of every printed document: the company's logo and name, and the product's name. */
export function PrintHeader({ companyName, productName, logoUrl }: HeaderProps) {
  return (
    <header data-testid="print-header" className="flex items-center justify-between gap-6 border-b-2 border-foreground pb-4">
      <div className="flex min-w-0 items-center gap-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served per session by /branding/logo, not a static asset
          <img src={logoUrl} alt="" className="h-16 w-auto max-w-48 object-contain" />
        ) : null}
        <p className="truncate text-2xl font-bold tracking-tight">{companyName}</p>
      </div>
      <p className="flex-none text-xs text-muted-foreground">{productName}</p>
    </header>
  );
}

export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      Print
    </Button>
  );
}
