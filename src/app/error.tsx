"use client"; // Error boundaries must be Client Components

import { Button } from "@/components/ui/button";

// Shown in place of a page that failed while loading, for example when the database cannot be
// reached. The details stay in the server log; the reader gets a way to try again.
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-medium">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This page could not be loaded. Try again; if it keeps happening, wait a minute first.
      </p>
      {digest ? <p className="font-mono text-xs text-muted-foreground">Reference {digest}</p> : null}
      <Button onClick={() => retry()}>Try again</Button>
    </main>
  );
}
