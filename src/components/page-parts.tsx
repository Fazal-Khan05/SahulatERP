import { cn } from "@/lib/utils";

/** The title of a screen, with an optional line under it. */
export function PageHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="mb-[18px]">
      <h1 className="text-2xl leading-tight font-bold tracking-tight max-sm:text-[22px]">{title}</h1>
      {sub ? <p className="mt-0.5 text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** A white panel on the paper background. */
export function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[10px] border bg-card shadow-xs", className)}>
      {title ? <h2 className="border-b px-[18px] py-3 text-base font-bold max-sm:px-3.5">{title}</h2> : null}
      <div className="px-[18px] py-4 max-sm:px-3.5">{children}</div>
    </section>
  );
}

/** What a list shows when it has nothing in it. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-muted-foreground">{children}</p>;
}
