import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { listAccounts } from "@/modules/ledger/queries";
import { visibleAccounts } from "@/modules/ledger/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { can } from "@/modules/tenant/rules";
import { addAccountAction, seedAccountsAction } from "./actions";

export const metadata: Metadata = { title: "Chart of accounts" };

export default function AccountsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Accounts />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{children}</span>;
}

async function Accounts() {
  const session = await requireTenant();
  if (!can(session.role, "account.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the chart of accounts.</p>;
  }
  const [all, setup] = await Promise.all([listAccounts(session), getCompanySetup(session)]);
  // A company not registered for sales tax sees no tax anywhere, its chart included.
  const chart = visibleAccounts(all, setup?.salesTaxRegistered ?? true);
  const manager = can(session.role, "account.manage");

  if (chart.length === 0) {
    return (
      <Card title="Chart of accounts" className="max-w-xl">
        <Empty>This company has no accounts yet.</Empty>
        {!can(session.role, "account.seed") ? (
          <p className="text-sm text-muted-foreground">The owner creates the chart of accounts.</p>
        ) : setup ? (
          <ActionForm action={seedAccountsAction} submitLabel="Create the chart of accounts" />
        ) : (
          <p className="text-sm text-muted-foreground">
            The chart of accounts is created when the company is set up.{" "}
            <Link href="/setup" className="font-medium text-foreground underline underline-offset-4">
              Finish setting up
            </Link>
          </p>
        )}
      </Card>
    );
  }

  const headings = chart.filter((account) => account.isGroup && account.archivedAt === null);
  return (
    <div className="grid max-w-5xl items-start gap-5 lg:grid-cols-[2fr_1fr]">
      <Card title="Chart of accounts">
        <p className="mb-2 text-sm text-muted-foreground">
          Every amount in the books sits in one of these accounts. Headings group accounts and are never posted to. Locked accounts
          are the ones the product itself relies on; the rest are yours to add, rename, archive or delete.
        </p>
        <div className="overflow-x-auto">
          <table aria-label="Chart of accounts" className="w-full min-w-[440px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Code</th>
                <th className="py-2 pr-4 font-medium">Account</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {chart.map((account) => (
                <tr key={account.id} className={account.archivedAt ? "text-muted-foreground" : undefined}>
                  <td className="py-1.5 pr-4 tabular-nums whitespace-nowrap">{account.code}</td>
                  <td className="py-1.5 pr-4" style={{ paddingLeft: account.depth * 18 }}>
                    {account.isControl ? (
                      <span className={account.isGroup ? "font-bold" : "font-medium"}>{account.name}</span>
                    ) : (
                      <Link href={`/settings/accounts/${account.id}`} className={`underline-offset-4 hover:underline ${account.isGroup ? "font-bold" : ""}`}>
                        {account.name}
                      </Link>
                    )}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {account.archivedAt ? <Pill>Archived</Pill> : account.isControl && !account.isGroup ? <Pill>Locked</Pill> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {manager ? (
        <Card title="Add an account">
          <ActionForm action={addAccountAction} submitLabel="Add account">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="parentId">Under</Label>
              <select id="parentId" name="parentId" required defaultValue="" className={SELECT}>
                <option value="" disabled>
                  Choose a heading
                </option>
                {headings.map((heading) => (
                  <option key={heading.id} value={heading.id}>
                    {`${"  ".repeat(heading.depth)}${heading.code} ${heading.name}`}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">The new account is the same type as its heading.</p>
            </div>
            <Field label="Name" name="name" required maxLength={80} hint="Such as Shop rent or HBL current account." />
            <Field label="Code" name="code" maxLength={12} autoComplete="off" hint="Leave empty for the next free number." />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium">This is</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="kind" value="account" defaultChecked className="mt-0.5 size-4" />
                <span>An account, to post amounts to</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="kind" value="heading" className="mt-0.5 size-4" />
                <span>A heading, to group accounts under</span>
              </label>
            </fieldset>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
