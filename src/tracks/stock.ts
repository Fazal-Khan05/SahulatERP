import type { ReportSection, TrackLinks, TrackPermissions } from "./shape";

// Track B, stock and buying: Steps 30, 24, 25, 26, 27, 28, 29 and 31.
//
// Whatever this track adds to a list the whole app shares, it adds here. The other two tracks
// have files of their own beside this one, and nobody edits another track's file. See
// docs/PARALLEL.md.
//
// Plain lists only. Import types, never a value from a module: the modules read this file.

/** Who may do what on this track's screens. Asked through can(), like every other permission. */
export const permissions = {
  // Step 30. How much each warehouse holds, in quantities only; what it cost is "stock.cost.read".
  "stock.read": ["owner", "accountant", "auditor", "sales_manager", "warehouse_manager"],
  "stock_transfer.read": ["owner", "accountant", "auditor", "warehouse_manager"],
  "stock_transfer.manage": ["owner", "accountant", "warehouse_manager"],
  // Adjustments and opening stock change what the books say stock is worth: not for the warehouse.
  "stock_adjustment.read": ["owner", "accountant", "auditor"],
  "stock_adjustment.manage": ["owner", "accountant"],
  // The warehouse counts; an owner or an accountant posts the differences.
  "stock_count.read": ["owner", "accountant", "auditor", "warehouse_manager"],
  "stock_count.manage": ["owner", "accountant", "warehouse_manager"],
  "stock_count.post": ["owner", "accountant"],
} as const satisfies TrackPermissions;

/**
 * Where this track's menu entries lead: null until the screen is built, then its address. The
 * words and the order of each role's menu are in src/modules/tenant/rules.ts and do not change.
 */
export const links = {
  purchases: null,
  billsAndPayments: null,
  stock: "/stock",
  receiveGoods: null,
  transfers: "/stock/transfers",
  stockCount: "/stock/counts",
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
export const documents = { SC: "Stock count" } as const satisfies Record<string, string>;

/** This track's reports, listed on the Reports page under headings of its own. */
export const reports: readonly ReportSection[] = [
  {
    title: "Stock",
    reports: [
      // The accountant's menu has no Stock entry; this is how an accountant reaches the stock screens.
      { label: "Stock on hand", href: "/stock", about: "What each warehouse holds, with transfers, adjustments, opening stock and counts.", permission: "stock.read", module: "inventory" },
    ],
  },
];
