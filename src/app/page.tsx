export default function Page() {
  // Vercel sets VERCEL_GIT_COMMIT_SHA at build time; local builds have none.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-xl font-medium">SahulatERP — rebuilding</h1>
      <p className="font-mono text-sm text-foreground/60">{commit}</p>
    </main>
  );
}
