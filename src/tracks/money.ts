import type { ReportSection, TrackLinks, TrackPermissions } from "./shape";

// Track C, bank, commissions and payroll: Steps 37, 40, 34, 35, 38, 39, 41 and 42.
//
// Whatever this track adds to a list the whole app shares, it adds here. The other two tracks
// have files of their own beside this one, and nobody edits another track's file. See
// docs/PARALLEL.md.
//
// Plain lists only. Import types, never a value from a module: the modules read this file.

/** Who may do what on this track's screens. Asked through can(), like every other permission. */
export const permissions = {
  // Step 37. Only the owner sets up commission plans and the sales hierarchy (the founder's
  // decision, 2026-11-14); the accountant, the auditor and the sales manager read them. The
  // database's policies in drizzle/0025_commission_plans.sql name the same roles.
  "commission.read": ["owner", "accountant", "auditor", "sales_manager"],
  "commission.manage": ["owner"],
  // Step 38. What the sales team has earned. The owner, an accountant and the auditor read
  // everyone's; whoever can earn commission reads their own. The owner and an accountant
  // approve it for payment and pay it (the founder's decision, 2026-11-15).
  "commission_earned.read": ["owner", "accountant", "auditor"],
  "commission_earned.own": ["owner", "sales_manager", "salesperson"],
  "commission.approve": ["owner", "accountant"],
  "commission.pay": ["owner", "accountant"],
  // Step 34. The company's cash and bank accounts, transfers between them and expenses paid out
  // of them: kept by the owner and an accountant, read by the auditor too. The policies and
  // functions in drizzle/0038_cash_bank.sql name the same roles.
  "cash_bank.read": ["owner", "accountant", "auditor"],
  "cash_bank.manage": ["owner", "accountant"],
  // Step 40. Employees and what they are paid are read by the owner, the payroll administrator,
  // the accountant and the auditor (the founder's decision, 2026-11-15), and kept by the owner
  // and the payroll administrator. The statutory tables are the law: every member reads them;
  // the owner, the accountant and the payroll administrator keep them, as tax rates are kept.
  // The policies in drizzle/0037_payroll_employees.sql name the same roles.
  "payroll.read": ["owner", "payroll_administrator", "accountant", "auditor"],
  "payroll.manage": ["owner", "payroll_administrator"],
  "statutory_rate.manage": ["owner", "accountant", "payroll_administrator"],
} as const satisfies TrackPermissions;

/**
 * Where this track's menu entries lead: null until the screen is built, then its address. The
 * words and the order of each role's menu are in src/modules/tenant/rules.ts and do not change.
 */
export const links = {
  cashAndBank: "/cash-bank",
  commissions: "/commissions",
  myCommission: "/commissions/earned",
  payroll: "/payroll",
  employees: "/payroll/employees",
  payrollRuns: null,
  payslips: null,
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
export const documents = {
  // Step 38: a commission payment to one person.
  CP: "Commission payment",
  // Step 34: money moved between two of the company's cash and bank accounts.
  TR: "Cash transfer",
} as const satisfies Record<string, string>;

/** This track's reports, listed on the Reports page under headings of its own. */
export const reports: readonly ReportSection[] = [
  {
    title: "Cash and bank",
    reports: [
      // Step 35. Each bank account's statements matched with the books.
      { label: "Bank reconciliation", href: "/cash-bank/reconcile", about: "Each bank account's statements from the bank, matched with the books: what is still to come through, and whether the books agree with the bank.", permission: "cash_bank.read", module: "cash_bank" },
    ],
  },
  {
    title: "Commissions",
    reports: [
      // The accountant's menu has no Commissions entry; this is how an accountant reaches the plans.
      { label: "Commission plans", href: "/commissions", about: "Who is on which plan, its rates, slabs and target, and who reports to whom.", permission: "commission.read", module: "commissions" },
      { label: "Commission earned", href: "/commissions/earned", about: "What each person has earned, what the customers' payments have released, what has been paid and what is owed back. Approve and pay here.", permission: "commission_earned.read", module: "commissions" },
      // Step 39. Each person's statement for a period, with its print and PDF.
      { label: "Commission statements", href: "/commissions/statements", about: "Each person's commission over a period: earned, released by the customers' payments, paid, and what is owed. Print or download each as a PDF.", permission: "commission_earned.read", module: "commissions" },
    ],
  },
];
