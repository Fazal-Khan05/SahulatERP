import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { getAccount } from "@/modules/ledger/queries";
import { ACCOUNT_TYPE_LABELS, lockedReason } from "@/modules/ledger/rules";
import { can } from "@/modules/tenant/rules";
import { deleteAccountAction, setAccountArchivedAction, updateAccountAction } from "../actions";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage({ params }: PageProps<"/settings/accounts/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AccountDetail params={params} />
    </Suspense>
  );
}

async function AccountDetail({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  if (!can(session.role, "account.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the chart of accounts.</p>;
  }
  const { id } = await params;
  const account = await getAccount(session, id);
  if (!account) notFound();
  const parent = account.parentId ? await getAccount(session, account.parentId) : null;
  const locked = lockedReason(account);
  const manager = can(session.role, "account.manage") && locked === null;
  const archived = account.archivedAt !== null;

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <p className="text-sm">
        <Link href="/settings/accounts" className="text-muted-foreground underline-offset-4 hover:underline">
          Chart of accounts
        </Link>
      </p>
      <Card title={`${account.code} ${account.name}`}>
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Type</dt>
          <dd>{ACCOUNT_TYPE_LABELS[account.type]}</dd>
          <dt className="text-muted-foreground">Under</dt>
          <dd>{parent ? `${parent.code} ${parent.name}` : "Nothing: this is a root"}</dd>
          <dt className="text-muted-foreground">Kind</dt>
          <dd>{account.isGroup ? "Heading: groups accounts, never posted to" : "Account"}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd data-testid="account-status">{archived ? "Archived" : "In use"}</dd>
        </dl>
        {locked ? <p className="text-sm text-muted-foreground">{locked}</p> : null}
        {manager && !archived ? (
          <ActionForm action={updateAccountAction.bind(null, account.id, account.updatedAt.toISOString())} submitLabel="Save changes">
            <Field label="Name" name="name" defaultValue={account.name} required maxLength={80} />
            <Field label="Code" name="code" defaultValue={account.code} required maxLength={12} autoComplete="off" />
          </ActionForm>
        ) : null}
      </Card>

      {manager ? (
        <Card title={archived ? "Restore or delete" : "Archive or delete"}>
          <p className="mb-3 text-sm text-muted-foreground">
            An archived account stays in the books but is no longer offered. An account can be deleted only while nothing has been
            posted to it.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={setAccountArchivedAction.bind(null, account.id, account.updatedAt.toISOString(), !archived)} submitLabel={archived ? "Restore account" : "Archive account"} compact />
            <ActionForm action={deleteAccountAction.bind(null, account.id, account.updatedAt.toISOString())} submitLabel="Delete account" compact />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
