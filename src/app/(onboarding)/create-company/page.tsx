import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { signOutAction } from "@/lib/auth/actions";
import { getTenantSession, requireUser } from "@/lib/auth/session";
import { createCompanyAction } from "./actions";

export const metadata: Metadata = { title: "Create your company — SahulatERP" };

export default function CreateCompanyPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <p className="text-lg font-medium">SahulatERP</p>
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-xl border bg-card p-6">
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <CreateCompany />
        </Suspense>
      </div>
    </main>
  );
}

async function CreateCompany() {
  const user = await requireUser();
  const session = await getTenantSession();

  if (!user.canCreateCompany) {
    return (
      <>
        <h1 className="text-xl font-medium">No company yet</h1>
        <p className="text-sm text-muted-foreground">
          {session
            ? "Your account cannot create a company."
            : `${user.email} is not a member of any company yet. Ask the owner who invited you to send the invitation again.`}
        </p>
        {session ? (
          <Link href="/" className="text-sm underline underline-offset-4">
            Back to {session.tenantName}
          </Link>
        ) : null}
        <SignOut />
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-medium">Create your company</h1>
      <p className="text-sm text-muted-foreground">
        You will be its owner. Branches, people and everything else come after.
      </p>
      <ActionForm action={createCompanyAction} submitLabel="Create company">
        <Field label="Company name" name="name" required minLength={2} maxLength={120} autoFocus />
      </ActionForm>
      {session ? (
        <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">
          Back to {session.tenantName}
        </Link>
      ) : (
        <SignOut />
      )}
    </>
  );
}

function SignOut() {
  return <ActionForm action={signOutAction} submitLabel="Sign out" compact />;
}
