import { Suspense } from "react";
import { PageHead } from "@/components/page-parts";
import { TabLink } from "@/components/shell/nav-link";
import { requireTenant } from "@/lib/auth/session";
import { can } from "@/modules/tenant/rules";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHead title="Settings" />
      <nav aria-label="Settings" className="mb-5 flex min-h-9 gap-1 overflow-x-auto">
        <Suspense fallback={null}>
          <Tabs />
        </Suspense>
      </nav>
      {children}
    </>
  );
}

// Only the parts of settings this role may open.
async function Tabs() {
  const { role } = await requireTenant();
  return (
    <>
      {can(role, "settings.read") ? (
        <>
          <TabLink href="/settings" exact>
            General
          </TabLink>
          <TabLink href="/settings/modules">Modules</TabLink>
        </>
      ) : null}
      {can(role, "currency.read") ? <TabLink href="/settings/currencies">Currencies</TabLink> : null}
      {can(role, "tax.read") ? <TabLink href="/settings/tax">Tax</TabLink> : null}
      {can(role, "account.read") ? <TabLink href="/settings/accounts">Accounts</TabLink> : null}
      {can(role, "period.read") ? <TabLink href="/settings/periods">Fiscal periods</TabLink> : null}
      <TabLink href="/settings/branches">Branches</TabLink>
      {can(role, "member.read") ? <TabLink href="/settings/members">Members</TabLink> : null}
      {can(role, "file.read") ? <TabLink href="/settings/files">Files</TabLink> : null}
      {can(role, "audit.read") ? <TabLink href="/settings/activity">Activity</TabLink> : null}
    </>
  );
}
