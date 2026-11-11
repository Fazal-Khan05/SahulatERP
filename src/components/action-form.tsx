"use client";

import { startTransition, useActionState, useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/form-state";
import { cn } from "@/lib/utils";

export type FormAction<S extends FormState = FormState> = (state: S, formData: FormData) => Promise<S>;

const noSubscription = () => () => {};

/**
 * Runs a server action for a form. Follows the action's `location` with a full page load, and
 * reports `ready` only once the page is interactive, so a form is never sent before this code
 * can handle its answer.
 */
export function useFormAction<S extends FormState = FormState>(action: FormAction<S>) {
  const [state, dispatch, pending] = useActionState(action, {} as Awaited<S>);
  const ready = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (state.location) window.location.assign(state.location);
  }, [state]);

  return {
    state,
    ready,
    busy: pending || Boolean(state.location),
    run: (data: FormData) => startTransition(() => dispatch(data)),
  };
}

type Props = {
  action: FormAction;
  submitLabel: string;
  children?: React.ReactNode;
  className?: string;
  /** For a button that sits in a row, such as Sign out. */
  compact?: boolean;
};

/**
 * A form bound to a server action. Shows the action's error or note, keeps what was typed when
 * the action refuses, and clears the fields when it succeeds.
 */
export function ActionForm({ action, submitLabel, children, className, compact = false }: Props) {
  const { state, ready, busy, run } = useFormAction(action);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form
      ref={form}
      // Submitting by hand stops React from clearing the fields when the action returns an error.
      onSubmit={(event) => {
        event.preventDefault();
        run(new FormData(event.currentTarget));
      }}
      className={cn(compact ? "flex items-center gap-2" : "flex flex-col gap-4", className)}
    >
      {children}
      {state.error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={!ready || busy}
        variant={compact ? "outline" : "default"}
        size={compact ? "sm" : "default"}
        className={compact ? undefined : "self-start"}
      >
        {busy && !compact ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
