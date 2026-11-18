import type { ReportSection, TrackLinks, TrackPermissions } from "./shape";

// Track A, selling and collecting: Steps 21, 22, 23, 32, 33 and 43 to 46.
//
// Whatever this track adds to a list the whole app shares, it adds here. The other two tracks
// have files of their own beside this one, and nobody edits another track's file. See
// docs/PARALLEL.md.
//
// Plain lists only. Import types, never a value from a module: the modules read this file.

/** Who may do what on this track's screens. Asked through can(), like every other permission. */
export const permissions = {
  // Step 23: email a numbered sales document to the customer. The same roles that write sales
  // documents; the database's own policy on sales_document_emails names the same four.
  "sales.email": ["owner", "accountant", "sales_manager", "salesperson"],
  // Step 32. Money received from customers, and the cheques among it. The founder's decision
  // (2026-11-14): the sales team sees what a customer owes and does not record money.
  "receipt.read": ["owner", "accountant", "auditor", "recovery_officer"],
  "receipt.manage": ["owner", "accountant", "recovery_officer"],
  // Step 21. A return and its credit note are recorded by the owner, an accountant or the sales
  // manager (the founder's decision, 2026-11-14: a salesperson asks one of them). Setting the
  // credit that is left over against other invoices is settling what a customer owes: the owner
  // and an accountant.
  "credit_note.manage": ["owner", "accountant", "sales_manager"],
  "credit_note.apply": ["owner", "accountant"],
  // Step 33. Recovery is worked by the recovery officer, the owner, the accountant and the sales
  // manager; the auditor reads it (the founder's decision, 2026-11-14). The database's policies
  // and functions in drizzle/0023_recovery.sql name the same roles.
  "recovery.read": ["owner", "accountant", "auditor", "recovery_officer", "sales_manager"],
  "recovery.manage": ["owner", "accountant", "recovery_officer", "sales_manager"],
  // Step 22. A sale at the counter to a walk-in buyer, who pays at once: it sells and takes the
  // money in one act, so it is for those who do both, the owner and an accountant. The policies
  // on counter_sales and app.walk_in_customer() in drizzle/0035_counter_sales.sql name the same two.
  "counter_sale.manage": ["owner", "accountant"],
} as const satisfies TrackPermissions;

/**
 * Where this track's menu entries lead: null until the screen is built, then its address. The
 * words and the order of each role's menu are in src/modules/tenant/rules.ts and do not change.
 */
export const links = {
  collections: "/recovery",
  salesReports: null,
  cheques: "/receipts/cheques",
  overdueCustomers: "/recovery/overdue",
  followUps: "/recovery/follow-ups",
  receipts: "/receipts",
  customerStatements: "/recovery/statements",
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
export const reports: readonly ReportSection[] = [
  {
    title: "Receivables",
    reports: [
      { label: "Aged receivables", href: "/recovery/ageing", about: "What each customer owes, by days past the due date.", permission: "recovery.read", module: "collections" },
      { label: "Customer statements", href: "/recovery/statements", about: "A customer's invoices and payments over a period, with the balance after each.", permission: "recovery.read", module: "collections" },
    ],
  },
];
