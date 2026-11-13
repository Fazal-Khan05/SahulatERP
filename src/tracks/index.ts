import { can, type MemberRole, type ModuleState } from "@/modules/tenant/rules";
import * as money from "./money";
import * as selling from "./selling";
import * as stock from "./stock";
import type { ReportSection } from "./shape";

// The three tracks together, for the screens that show something from each. The lists
// themselves (permissions, menu, locked accounts, document kinds) are read where they are used:
// src/modules/tenant/rules.ts, src/modules/ledger/rules.ts and src/modules/numbering/rules.ts.

export const TRACKS = { selling, stock, money } as const;

/** The tracks' reports this role may open, under their headings; a heading with nothing to show is left out. */
export function reportsFor(role: MemberRole, on: ModuleState, sections: readonly ReportSection[] = Object.values(TRACKS).flatMap((track) => track.reports)): ReportSection[] {
  return sections
    .map((section) => ({ title: section.title, reports: section.reports.filter((report) => can(role, report.permission) && (report.module === undefined || on[report.module])) }))
    .filter((section) => section.reports.length > 0);
}
