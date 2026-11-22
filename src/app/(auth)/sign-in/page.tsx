import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { signInAction } from "../actions";

export const metadata: Metadata = { title: "Sign in — SahulatERP" };

const ENDED: Record<string, string> = {
  idle: "You were signed out because the app was not used for a while.",
  limit: "Your session has run its full length. Sign in again to go on.",
};

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Sign in</h1>
      <Suspense fallback={null}>
        <Ended searchParams={searchParams} />
      </Suspense>
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

async function Ended({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const ended = (await searchParams).ended;
  const note = typeof ended === "string" ? ENDED[ended] : undefined;
  return note ? (
    <p role="status" className="text-sm text-muted-foreground">
      {note}
    </p>
  ) : null;
}
