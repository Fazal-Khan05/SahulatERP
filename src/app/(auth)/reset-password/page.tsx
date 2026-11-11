import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { getSessionUser } from "@/lib/auth/session";
import { setPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Choose a password — SahulatERP" };

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Choose a password</h1>
      <Suspense fallback={null}>
        <Account />
      </Suspense>
      <ActionForm action={setPasswordAction} submitLabel="Save password">
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint="At least 10 characters."
          autoFocus
        />
        <Field label="Type it again" name="confirm" type="password" autoComplete="new-password" required />
      </ActionForm>
    </div>
  );
}

// Shows whose password is about to change, so nobody sets one on an account that is not theirs.
async function Account() {
  const user = await getSessionUser();
  return user ? <p className="text-sm text-muted-foreground">For {user.email}</p> : null;
}
