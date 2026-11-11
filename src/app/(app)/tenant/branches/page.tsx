import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { requireTenant } from "@/lib/auth/session";
import { listBranches } from "@/modules/tenant/queries";
import { can } from "@/modules/tenant/rules";
import { createBranchAction } from "../actions";

export const metadata: Metadata = { title: "Branches — SahulatERP" };

// The session and the rows are read at request time, behind the boundary, so moving between
// pages shows the frame at once and the content as soon as it is ready.
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
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-medium">Branches</h1>
        <p className="text-sm text-muted-foreground">
          {session.branchIds === null
            ? `Every branch of ${session.tenantName}.`
            : `The branches of ${session.tenantName} you work in.`}
        </p>
      </div>
      {branches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No branches yet.</p>
      ) : (
        <ul aria-label="Branches" className="divide-y rounded-xl border">
          {branches.map((branch) => (
            <li key={branch.id} className="px-4 py-2.5 text-sm">
              {branch.name}
            </li>
          ))}
        </ul>
      )}
      {can(session.role, "branch.create") ? (
        <div className="max-w-sm">
          <h2 className="mb-3 font-medium">Add a branch</h2>
          <ActionForm action={createBranchAction} submitLabel="Add branch">
            <Field label="Branch name" name="name" required maxLength={80} />
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}
