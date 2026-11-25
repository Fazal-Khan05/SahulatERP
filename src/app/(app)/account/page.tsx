import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { PageHead, Card } from "@/components/page-parts";
import { PageLoading } from "@/components/page-loading";
import { IDLE_MINUTES, MAX_SESSION_HOURS, twoStepRequiredFor, twoStepRequiredOfCreator } from "@/lib/auth/rules";
import { hasAuthenticator, requireTenant } from "@/lib/auth/session";
import { removeTwoStepAction, signOutEverywhereAction } from "@/lib/auth/two-step";

export const metadata: Metadata = { title: "Your account — SahulatERP" };

export default function AccountPage() {
  return (
    <>
      <PageHead title="Your account" />
      <Suspense fallback={<PageLoading />}>
        <Account />
      </Suspense>
    </>
  );
}

async function Account() {
  const session = await requireTenant();
  const on = await hasAuthenticator();
  const required =
    twoStepRequiredOfCreator(session.canCreateCompany) ||
    session.memberships.some((m) => m.active && twoStepRequiredFor(m.role));
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Card title="Two-step sign-in">
        <div className="flex flex-col gap-3 text-sm">
          <p data-testid="two-step-status">
            {on
              ? "On. After your password, you give a code from the authenticator app on your phone."
              : "Off. Only your password protects your account."}
          </p>
          {on && required ? (
            <p className="text-muted-foreground">Your role needs it, so it stays on.</p>
          ) : null}
          {on && !required ? <ActionForm action={removeTwoStepAction} submitLabel="Turn it off" compact /> : null}
          {on ? null : (
            <Link href="/two-step/setup" className="self-start underline underline-offset-4">
              Set it up
            </Link>
          )}
        </div>
      </Card>
      <Card title="Password">
        <Link href="/reset-password" className="text-sm underline underline-offset-4">
          Choose a new password
        </Link>
      </Card>
      <Card title="Sessions">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            You are signed out after {IDLE_MINUTES} minutes without use, and {MAX_SESSION_HOURS} hours after you signed
            in. Lost a phone or left a computer signed in? Sign out everywhere; any device still signed in is cut off within
            the hour.
          </p>
          <ActionForm action={signOutEverywhereAction} submitLabel="Sign out everywhere" compact />
        </div>
      </Card>
    </div>
  );
}
