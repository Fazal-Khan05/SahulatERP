import { DEFAULT_PRODUCT_NAME } from "@/modules/tenant/rules";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  // Vercel sets VERCEL_GIT_COMMIT_SHA at build time; local builds have none.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <p className="flex items-center gap-2 text-lg font-bold tracking-tight">
        <span
          aria-hidden="true"
          className="grid size-[26px] place-items-center rounded-[7px] bg-primary text-sm font-bold text-primary-foreground"
        >
          {DEFAULT_PRODUCT_NAME.charAt(0)}
        </span>
        <span>{DEFAULT_PRODUCT_NAME}</span>
      </p>
      <div className="w-full max-w-sm rounded-[10px] border bg-card p-6 shadow-xs">{children}</div>
      <p className="font-mono text-xs text-muted-foreground">{commit.slice(0, 7)}</p>
    </main>
  );
}
