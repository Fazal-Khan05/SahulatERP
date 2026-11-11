import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { listBranches } from "@/modules/tenant/queries";
import { can } from "@/modules/tenant/rules";
import { createBranchAction } from "../actions";

export const metadata: Metadata = { title: "Branches" };

export default function BranchesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Branches />
    </Suspense>
  );
}

async function Branches() {
  const session = await requireTenant();
  const branches = await listBranches(session);
  return (
    <div className="flex max-w-xl flex-col gap-5">
      <Card title="Branches">
        <p className="mb-2 text-sm text-muted-foreground">
          {session.branchIds === null
            ? `Every branch of ${session.tenantName}.`
            : `The branches of ${session.tenantName} you work in.`}
        </p>
        {branches.length === 0 ? (
          <Empty>No branches yet.</Empty>
        ) : (
          <ul aria-label="Branches" className="divide-y">
            {branches.map((branch) => (
              <li key={branch.id} className="py-2.5">
                {branch.name}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {can(session.role, "branch.create") ? (
        <Card title="Add a branch">
          <ActionForm action={createBranchAction} submitLabel="Add branch">
            <Field label="Branch name" name="name" required maxLength={80} />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
