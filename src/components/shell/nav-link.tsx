"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

function isHere(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

const railItem =
  "flex flex-none items-center justify-between gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[14.5px] text-muted-foreground min-[921px]:border-l-[3px] min-[921px]:border-transparent min-[921px]:py-2";

/** An entry in the left rail; marks itself when its screen is open. */
export function RailLink({ href, children }: { href: string; children: React.ReactNode }) {
  const here = isHere(usePathname(), href, href === "/");
  return (
    <Link
      href={href}
      aria-current={here ? "page" : undefined}
      className={cn(
        railItem,
        here
          ? "bg-accent font-semibold text-foreground min-[921px]:border-l-primary min-[921px]:bg-card min-[921px]:shadow-sm"
          : "hover:bg-foreground/5",
      )}
    >
      {children}
    </Link>
  );
}

/** A rail entry whose screen is not built yet: visible, so the menu is honest, but not a link. */
export function RailSoon({ children }: { children: React.ReactNode }) {
  return (
    <span aria-disabled="true" title="Not built yet" className={cn(railItem, "cursor-default opacity-60")}>
      {children}
    </span>
  );
}

/** A tab in the settings area. */
export function TabLink({ href, exact = false, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const here = isHere(usePathname(), href, exact);
  return (
    <Link
      href={href}
      aria-current={here ? "page" : undefined}
      className={cn(
        "flex-none whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium",
        here ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-foreground/5",
      )}
    >
      {children}
    </Link>
  );
}
