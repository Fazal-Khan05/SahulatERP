import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { signOutAction } from "@/lib/auth/actions";
import { provedRecently, twoStepRequiredFor, twoStepRequiredOfCreator } from "@/lib/auth/rules";
import { getSignedInAccount, hasAuthenticator } from "@/lib/auth/session";
import { loadWorkspace } from "@/modules/tenant/queries";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Two-step sign-in — SahulatERP" };

export default function TwoStepSetupPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Two-step sign-in</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Setup />
      </Suspense>
    </div>
  );
}

async function Setup() {
  const account = await getSignedInAccount();
  if (!account) redirect("/sign-in");
  if (account.gate === "code") redirect("/two-step");
  if (account.level === "aal2" && (await hasAuthenticator())) redirect("/");
  const { memberships } = await loadWorkspace(account.id, null);
  const required =
    twoStepRequiredOfCreator(account.canCreateCompany) || memberships.some((m) => m.active && twoStepRequiredFor(m.role));
  return (
    <>
      <p className="text-sm text-muted-foreground">For {account.email}</p>
      <SetupForm required={required} askCurrent={!provedRecently(account.proofs)} />
      <ActionForm action={signOutAction} submitLabel="Sign out" compact />
    </>
  );
}
