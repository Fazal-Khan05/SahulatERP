export default function AuthLayout({ children }: LayoutProps<"/">) {
  // Vercel sets VERCEL_GIT_COMMIT_SHA at build time; local builds have none.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <p className="text-lg font-medium">SahulatERP</p>
      <div className="w-full max-w-sm rounded-xl border bg-card p-6">{children}</div>
      <p className="font-mono text-xs text-muted-foreground">{commit.slice(0, 7)}</p>
    </main>
  );
}
