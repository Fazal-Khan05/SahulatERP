import { Inbox } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Brand } from "@/components/shell/brand";
import { RailLink, RailSoon } from "@/components/shell/nav-link";
import { signOutAction } from "@/lib/auth/actions";
import { requireTenant } from "@/lib/auth/session";
import { ROLE_LABELS, navFor } from "@/modules/tenant/rules";
import { switchTenantAction } from "./actions";

// The frame every signed-in screen sits in: a top bar with the product, the company and the
// person, and a slim rail with only that role's menu. Follows docs/mockups.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b bg-card px-5 py-2.5 max-sm:gap-x-2.5 max-sm:px-3.5">
        {/* A quiet placeholder, not the default name: a company that renamed the product must never
            see the old name flash by while its own is on the way. */}
        <Suspense fallback={<span aria-hidden="true" className="h-[26px] w-36 rounded-md bg-muted" />}>
          <TopBar />
        </Suspense>
      </header>
      <div className="grid flex-1 content-start items-start min-[921px]:grid-cols-[204px_minmax(0,1fr)]">
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto border-b bg-card px-3 py-2 min-[921px]:sticky min-[921px]:top-0 min-[921px]:flex-col min-[921px]:gap-0.5 min-[921px]:overflow-visible min-[921px]:border-b-0 min-[921px]:bg-transparent min-[921px]:py-[18px] min-[921px]:pr-2 min-[921px]:pl-3"
        >
          <Suspense fallback={null}>
            <Rail />
          </Suspense>
        </nav>
        <main className="min-w-0 px-4 pt-[18px] pb-12 max-sm:px-3 min-[921px]:pt-[22px] min-[921px]:pr-6 min-[921px]:pb-14">
          {children}
        </main>
      </div>
    </div>
  );
}

async function TopBar() {
  const session = await requireTenant();
  const initials = session.email.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return (
    <>
      <Brand productName={session.branding.productName} logoUrl={session.branding.logoUrl} />
      <span
        data-testid="company-name"
        className="min-w-0 truncate border-l border-input pl-3.5 text-[13.5px] text-muted-foreground max-sm:hidden"
      >
        {session.tenantName}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3.5 gap-y-2">
        <Link
          href="/inbox"
          aria-label="Needs attention"
          className="inline-flex items-center gap-2 rounded-lg border border-input px-2.5 py-1 text-sm font-semibold whitespace-nowrap hover:bg-muted"
        >
          <Inbox aria-hidden="true" className="size-4" />
          <span className="max-sm:hidden">Needs attention</span>
        </Link>
        {session.memberships.length > 1 ? (
          <ActionForm action={switchTenantAction} submitLabel="Switch" compact>
            <label htmlFor="tenantId" className="sr-only">
              Company
            </label>
            <select
              id="tenantId"
              name="tenantId"
              defaultValue={session.tenantId}
              className="h-8 max-w-44 rounded-lg border border-input bg-card px-2 text-sm"
            >
              {session.memberships.map((m) => (
                <option key={m.tenantId} value={m.tenantId}>
                  {m.tenantName}
                </option>
              ))}
            </select>
          </ActionForm>
        ) : null}
        <div className="flex items-center gap-2 text-[13.5px] leading-tight whitespace-nowrap">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-full bg-muted text-[12.5px] font-bold text-muted-foreground"
          >
            {initials}
          </span>
          <span className="max-sm:hidden">
            {session.email}
            <small className="block text-[12.5px] text-muted-foreground">{ROLE_LABELS[session.role]}</small>
          </span>
        </div>
        {session.canCreateCompany ? (
          <Link href="/create-company" className="text-sm text-muted-foreground underline underline-offset-4 max-md:hidden">
            New company
          </Link>
        ) : null}
        <ActionForm action={signOutAction} submitLabel="Sign out" compact />
      </div>
    </>
  );
}

async function Rail() {
  const session = await requireTenant();
  return navFor(session.role, session.modules).map((entry) =>
    entry.href ? (
      <RailLink key={entry.label} href={entry.href}>
        {entry.label}
      </RailLink>
    ) : (
      <RailSoon key={entry.label}>{entry.label}</RailSoon>
    ),
  );
}
