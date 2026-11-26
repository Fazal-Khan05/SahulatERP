"use client";

import { useEffect, useRef, useState } from "react";
import { useFormAction, type FormAction } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { shrinkPhoto } from "./shrink-photo";

/** Adds one receipt to an expense: a PDF, or a photo, which is made smaller first when it is large. */
export function ReceiptForm({ action, maxReceiptBytes, receiptTypes }: { action: FormAction; maxReceiptBytes: number; receiptTypes: string }) {
  const { state, ready, busy, run } = useFormAction(action);
  const [tooLarge, setTooLarge] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  const error = tooLarge ? "The receipt must be 4 MB or smaller." : state.error;
  return (
    <form
      ref={form}
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const receipt = data.get("receipt");
        if (receipt instanceof File && receipt.size > 0) {
          setPreparing(true);
          const ready = await shrinkPhoto(receipt);
          setPreparing(false);
          data.set("receipt", ready);
          if (ready.size > maxReceiptBytes) return setTooLarge(true);
        }
        setTooLarge(false);
        run(data);
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="receipt">Add a receipt</Label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          required
          accept={receiptTypes}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
        />
        <p className="text-xs text-muted-foreground">A PDF, or a photo of the bill as PNG, JPEG or WebP, 4 MB or smaller. A large photo is made smaller before it is sent.</p>
      </div>
      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state.message && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="outline" disabled={!ready || busy || preparing}>
          {busy || preparing ? "Working…" : "Keep with this expense"}
        </Button>
      </div>
    </form>
  );
}
