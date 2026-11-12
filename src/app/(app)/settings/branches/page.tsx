import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { Label } from "@/components/ui/label";
import { listBranches } from "@/modules/tenant/queries";
import { can } from "@/modules/tenant/rules";
import { listWarehouses } from "@/modules/warehouses/queries";
import { createBranchAction, createWarehouseAction } from "../actions";

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
  const [branches, warehouses] = await Promise.all([listBranches(session), listWarehouses(session)]);
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
      <Card title="Warehouses">
        <p className="mb-2 text-sm text-muted-foreground">Where stock is kept. Each warehouse belongs to a branch.</p>
        {warehouses.length === 0 ? (
          <Empty>No warehouses yet.</Empty>
        ) : (
          <ul aria-label="Warehouses" className="divide-y">
            {warehouses.map((warehouse) => (
              <li key={warehouse.id} className="py-2.5">
                {warehouse.name} <span className="text-muted-foreground">· {warehouse.branch}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {can(session.role, "warehouse.create") && branches.length > 0 ? (
        <Card title="Add a warehouse">
          <ActionForm action={createWarehouseAction} submitLabel="Add warehouse">
            <Field id="warehouse-name" label="Warehouse name" name="name" required maxLength={80} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branchId">Branch</Label>
              <select id="branchId" name="branchId" required defaultValue={branches.length === 1 ? branches[0].id : ""} className="h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm">
                <option value="" disabled>
                  Choose a branch
                </option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
