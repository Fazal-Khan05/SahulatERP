"use client";

import Link from "next/link";
import { useFormAction } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { setupAction } from "@/lib/auth/two-step";

/** The key in groups of four, easier to type into an app by hand. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function SetupForm({ required }: { required: boolean }) {
  const { state, ready, busy, run } = useFormAction(setupAction);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(new FormData(event.currentTarget));
  };
  const error = state.error ? (
    <p role="alert" data-testid="form-error" className="text-sm text-destructive">
      {state.error}
    </p>
  ) : null;

  if (!state.factorId || !state.qr || !state.secret) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="hidden" name="step" value="start" />
        <p className="text-sm text-muted-foreground">
          {required
            ? "Your role needs two-step sign-in. After your password you will also give a code from an app on your phone."
            : "Protect your account with a code from an app on your phone, asked for after your password."}{" "}
          Any authenticator app works: Google Authenticator, Microsoft Authenticator, Authy.
        </p>
        {error}
        <div className="flex items-center gap-4">
          <Button type="submit" disabled={!ready || busy}>
            {busy ? "Working…" : "Set it up"}
          </Button>
          {required ? null : (
            <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">
              Not now
            </Link>
          )}
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <input type="hidden" name="step" value="finish" />
      <p className="text-sm text-muted-foreground">Scan this code with your authenticator app.</p>
      {/* An SVG from Supabase Auth, shown as an image: nothing in it can run. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.qr} alt="QR code for your authenticator app" width={180} height={180} className="self-center" />
      <p className="text-sm text-muted-foreground">
        Or type this key into the app:{" "}
        <code data-testid="two-step-key" className="font-mono text-foreground">
          {grouped(state.secret)}
        </code>
      </p>
      <Field
        label="Code from the app"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        autoFocus
      />
      {error}
      <Button type="submit" disabled={!ready || busy} className="self-start">
        {busy ? "Working…" : "Turn on two-step sign-in"}
      </Button>
    </form>
  );
}
