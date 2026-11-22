import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { provedRecently } from "@/lib/auth/rules";
import { getSignedInAccount } from "@/lib/auth/session";
import { PASSWORD_MIN } from "@/modules/tenant/rules";
import { setPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Choose a password — SahulatERP" };

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Choose a password</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ChoosePassword />
      </Suspense>
    </div>
  );
}

async function ChoosePassword() {
  const account = await getSignedInAccount();
  // An account with an authenticator app gives its code first, even from an email link.
  if (account?.gate === "code") redirect("/two-step?next=/reset-password");
  // Shows whose password is about to change, so nobody sets one on an account that is not theirs.
  const askCurrent = account !== null && !provedRecently(account.proofs);
  return (
    <>
      {account ? <p className="text-sm text-muted-foreground">For {account.email}</p> : null}
      <ActionForm action={setPasswordAction} submitLabel="Save password">
        {askCurrent ? (
          <Field
            label="Current password"
            name="current"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        ) : null}
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          hint={`At least ${PASSWORD_MIN} characters. A long phrase is easiest to remember.`}
          autoFocus={!askCurrent}
        />
        <Field label="Type it again" name="confirm" type="password" autoComplete="new-password" required />
      </ActionForm>
    </>
  );
}
