import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { signOutAction } from "@/lib/auth/actions";
import { requireTenant } from "@/lib/auth/session";
import { ROLE_LABELS, can } from "@/modules/tenant/rules";
import { switchTenantAction } from "./actions";

// A plain frame for Step 2. The role-aware shell and navigation are Step 3.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <Link href="/" className="font-medium">
            SahulatERP
          </Link>
          <Suspense fallback={<span className="text-sm text-muted-foreground">Loading…</span>}>
            <Header />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}

async function Header() {
  const session = await requireTenant();
  return (
    <>
      <nav aria-label="Main" className="flex gap-4 text-sm">
        <Link href="/tenant/branches">Branches</Link>
        {can(session.role, "member.read") ? <Link href="/tenant/members">Members</Link> : null}
        {can(session.role, "audit.read") ? <Link href="/tenant/activity">Activity</Link> : null}
      </nav>
      <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
        {session.memberships.length > 1 ? (
          <ActionForm action={switchTenantAction} submitLabel="Switch" compact>
            <label htmlFor="tenantId" className="sr-only">
              Company
            </label>
            <select
              id="tenantId"
              name="tenantId"
              defaultValue={session.tenantId}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            >
              {session.memberships.map((m) => (
                <option key={m.tenantId} value={m.tenantId}>
                  {m.tenantName}
                </option>
              ))}
            </select>
          </ActionForm>
        ) : (
          <span data-testid="company-name" className="font-medium">
            {session.tenantName}
          </span>
        )}
        <span className="text-muted-foreground">{ROLE_LABELS[session.role]}</span>
        {session.canCreateCompany ? (
          <Link href="/create-company" className="text-muted-foreground underline underline-offset-4">
            New company
          </Link>
        ) : null}
        <ActionForm action={signOutAction} submitLabel="Sign out" compact />
      </div>
    </>
  );
}
