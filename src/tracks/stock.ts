import type { ReportSection, TrackLinks, TrackPermissions } from "./shape";

// Track B, stock and buying: Steps 30, 24, 25, 26, 27, 28, 29 and 31.
//
// Whatever this track adds to a list the whole app shares, it adds here. The other two tracks
// have files of their own beside this one, and nobody edits another track's file. See
// docs/PARALLEL.md.
//
// Plain lists only. Import types, never a value from a module: the modules read this file.

/** Who may do what on this track's screens. Asked through can(), like every other permission. */
export const permissions = {} as const satisfies TrackPermissions;

/**
 * Where this track's menu entries lead: null until the screen is built, then its address. The
 * words and the order of each role's menu are in src/modules/tenant/rules.ts and do not change.
 */
export const links = {
  purchases: null,
  billsAndPayments: null,
  stock: null,
  receiveGoods: null,
  transfers: null,
  stockCount: null,
} as const satisfies TrackLinks;

/**
 * Locked accounts this track adds, by what each is for. The account itself is added in the
 * step's migration with a function app.chart_extra_<name>().
 */
export const controls = {} as const satisfies Record<string, string>;

/**
 * Kinds of document this track numbers, by their two letters. The migration adds a function
 * app.document_type_<letters>() for each.
 */
export const documents = {} as const satisfies Record<string, string>;

/** This track's reports, listed on the Reports page under headings of its own. */
export const reports: readonly ReportSection[] = [];
