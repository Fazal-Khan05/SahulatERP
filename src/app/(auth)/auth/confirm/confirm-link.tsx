"use client";

import { useEffect, useRef } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/form-state";

type Props = {
  inspect: FormAction<FormState & { email?: string }>;
  confirm: FormAction;
};

/**
 * Finishes an invite or password-reset link. Takes the session Supabase Auth put in the address
 * fragment out of the address bar, asks the server whose account it is, shows that, and signs in
 * only when the reader presses Continue.
 */
export function ConfirmLink({ inspect, confirm }: Props) {
  const inspected = useFormAction(inspect);
  const confirmed = useFormAction(confirm);
  const tokens = useRef<FormData | null>(null);
  const inspectLink = inspected.run;

  useEffect(() => {
    if (tokens.current) return;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const data = new FormData();
    for (const key of ["access_token", "refresh_token", "type", "error_code"]) {
      const value = fragment.get(key);
      if (value) data.set(key, value);
    }
    tokens.current = data;
    inspectLink(data);
  }, [inspectLink]);

  const error = confirmed.state.error ?? inspected.state.error;
  if (error) {
    return (
      <p role="alert" data-testid="form-error" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (!inspected.state.email) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking your link…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        This link signs you in as <span className="font-medium">{inspected.state.email}</span>. Continue only if that
        is your address.
      </p>
      <Button
        type="button"
        className="self-start"
        disabled={confirmed.busy}
        onClick={() => {
          if (tokens.current) confirmed.run(tokens.current);
        }}
      >
        {confirmed.busy ? "Working…" : "Continue"}
      </Button>
    </div>
  );
}
