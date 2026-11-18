import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { signOutAction } from "@/lib/auth/actions";
import { getSignedInAccount } from "@/lib/auth/session";
import { giveCodeAction } from "@/lib/auth/two-step";
import { DEFAULT_PRODUCT_NAME } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Enter your code — SahulatERP" };

export default function TwoStepPage({ searchParams }: PageProps<"/two-step">) {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Enter your code</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <GiveCode searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function GiveCode({ searchParams }: Pick<PageProps<"/two-step">, "searchParams">) {
  const account = await getSignedInAccount();
  if (!account) redirect("/sign-in");
  if (account.gate !== "code") redirect("/");
  const next = (await searchParams).next === "/reset-password" ? "/reset-password" : "/";
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Open the authenticator app on your phone and enter the six-digit code it shows for {account.email}.
      </p>
      <ActionForm action={giveCodeAction} submitLabel="Continue">
        <input type="hidden" name="next" value={next} />
        <Field
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          required
          autoFocus
        />
      </ActionForm>
      <p className="text-sm text-muted-foreground">
        Lost your phone? Ask {DEFAULT_PRODUCT_NAME} support to turn two-step sign-in off for your account.
      </p>
      <ActionForm action={signOutAction} submitLabel="Sign out" compact />
    </>
  );
}
