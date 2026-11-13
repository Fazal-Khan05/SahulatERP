import type { MemberRole, ModuleKey, Permission } from "@/modules/tenant/rules";

// The remaining steps are built in three tracks at once (docs/PARALLEL.md). A few lists belong
// to the whole app: who may do what, where the menu leads, the locked accounts, the kinds of
// document that take a number, the reports. Each track adds to those lists in its own file in
// this folder, and the shared files read all three. Nobody building in parallel edits a shared
// list, so two people never change the same lines.

/** Who may do what: a permission's name, and the roles that hold it. */
export type TrackPermissions = Record<string, readonly MemberRole[]>;

/** Where a menu entry leads. null until the screen behind it is built. */
export type TrackLinks = Record<string, string | null>;

/** A report on the Reports page. It is listed for a role that holds `permission`, while `module` is on. */
export type TrackReport = { label: string; href: string; about: string; permission: Permission; module?: ModuleKey };

/** A track's reports under one heading. */
export type ReportSection = { title: string; reports: readonly TrackReport[] };
