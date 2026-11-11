import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { signInAction } from "../actions";

export const metadata: Metadata = { title: "Sign in — SahulatERP" };

export default function SignInPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Sign in</h1>
      <ActionForm action={signInAction} submitLabel="Sign in">
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      </ActionForm>
      <Link href="/forgot-password" className="text-sm text-muted-foreground underline underline-offset-4">
        Forgot your password?
      </Link>
    </div>
  );
}
