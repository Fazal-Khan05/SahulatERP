import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { forgotPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Forgot password — SahulatERP" };

export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Forgot your password?</h1>
      <p className="text-sm text-muted-foreground">Enter your email and we will send a link to choose a new one.</p>
      <ActionForm action={forgotPasswordAction} submitLabel="Send the link">
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
      </ActionForm>
      <Link href="/sign-in" className="text-sm text-muted-foreground underline underline-offset-4">
        Back to sign in
      </Link>
    </div>
  );
}
