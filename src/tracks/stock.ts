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
  // Step 24. An order carries what goods cost: for the owner and whoever keeps or checks the
  // books. The warehouse receives goods against it, in quantities only.
  "purchase_order.read": ["owner", "accountant", "auditor"],
  "purchase_order.manage": ["owner", "accountant"],
  "goods_receipt.read": ["owner", "accountant", "auditor", "warehouse_manager"],
  "goods_receipt.manage": ["owner", "accountant", "warehouse_manager"],
  // Step 25. A supplier's bill carries what was bought, what it cost and what tax was withheld.
  "supplier_bill.read": ["owner", "accountant", "auditor"],
  "supplier_bill.manage": ["owner", "accountant"],
  // Step 26. Paying suppliers, their advances, and the challans tax withheld is paid under.
  "supplier_payment.read": ["owner", "accountant", "auditor"],
  "supplier_payment.manage": ["owner", "accountant"],
  // Step 27. Goods sent back to a supplier, and what the supplier owes back for them.
  "supplier_return.read": ["owner", "accountant", "auditor"],
  "supplier_return.manage": ["owner", "accountant"],
} as const satisfies TrackPermissions;

/**
 * Where this track's menu entries lead: null until the screen is built, then its address. The
 * words and the order of each role's menu are in src/modules/tenant/rules.ts and do not change.
 */
export const links = {
  purchases: "/purchases",
  billsAndPayments: null,
  stock: "/stock",
  receiveGoods: "/purchases/receive",
  transfers: "/stock/transfers",
  stockCount: "/stock/counts",
} as const satisfies TrackLinks;

/**
 * Locked accounts this track adds, by what each is for. The account itself is added in the
 * step's migration with a function app.chart_extra_<name>().
 */
export const controls = {
  // Step 25. Where a supplier's bill differs from what its goods came into stock at.
  purchase_price_difference: "Purchase price differences",
} as const satisfies Record<string, string>;

/**
 * Kinds of document this track numbers, by their two letters. The migration adds a function
 * app.document_type_<letters>() for each.
 */
export const documents = { SC: "Stock count", WC: "Withholding challan" } as const satisfies Record<string, string>;

/** This track's reports, listed on the Reports page under headings of its own. */
export const reports: readonly ReportSection[] = [
  {
    title: "Purchases",
    reports: [
      { label: "Goods received, not yet billed", href: "/purchases/grni", about: "Goods that have arrived and have no supplier bill yet, at what they cost, against the account in the books.", permission: "purchase_order.read", module: "purchasing" },
    ],
  },
  {
    title: "Stock",
    reports: [
      // The accountant's menu has no Stock entry; this is how an accountant reaches the stock screens.
      { label: "Stock on hand", href: "/stock", about: "What each warehouse holds, with transfers, adjustments, opening stock and counts.", permission: "stock.read", module: "inventory" },
      // Step 31. What stock cost is for the owner, the accountant and the auditor (founder's decision, 2026-11-14).
      { label: "Stock valuation", href: "/stock-reports/valuation", about: "What the stock on hand is worth on a day, against the stock account in the books.", permission: "stock.cost.read", module: "inventory" },
      { label: "Stock movement", href: "/stock-reports/movement", about: "What came in and went out in a period, item by item, or every move of one item.", permission: "stock.cost.read", module: "inventory" },
      { label: "Stock ageing", href: "/stock-reports/ageing", about: "How long the stock on hand has been held, and when each item last sold.", permission: "stock.cost.read", module: "inventory" },
      { label: "Low stock", href: "/stock-reports/low-stock", about: "Items whose free stock is at or below their reorder level.", permission: "stock.read", module: "inventory" },
      { label: "Item profit", href: "/stock-reports/item-profit", about: "Sales, cost of goods sold and margin of each item in a period.", permission: "stock.cost.read", module: "inventory" },
    ],
  },
];
