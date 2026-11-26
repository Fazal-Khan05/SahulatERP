import { foreignKey, index, numeric, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { expenseWithholdings } from "../cash-bank/schema";
import { payrollRuns } from "../payroll-runs/schema";
import { withholdingChallans } from "../supplier-payments/schema";
import { tenants } from "../tenant/schema";

// A challan (Step 26) records tax paid over to the government: the tax withheld on supplier
// bills. Two later steps put tax into the same accounts that no challan could pay: tax withheld
// on an expense (Step 34) and the income tax a payroll run deducts from pay (Step 41). These
// two tables say which of those a challan paid, so that they leave "still to be paid" and the
// account comes down. Written only by app.record_tax_challan (drizzle, "tax paid over"), with
// the challan and its journal, once; never changed or removed.

/** Tax withheld on an expense that a challan paid: each entry once, whole. */
export const challanExpenseEntries = pgTable(
  "challan_expense_entries",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    challanId: uuid("challan_id").notNull(),
    entryId: uuid("entry_id").notNull(),
  },
  (t) => [
    unique("challan_expense_entries_entry_key").on(t.tenantId, t.entryId),
    foreignKey({ name: "challan_expense_entries_challan_fk", columns: [t.tenantId, t.challanId], foreignColumns: [withholdingChallans.tenantId, withholdingChallans.id] }),
    foreignKey({ name: "challan_expense_entries_entry_fk", columns: [t.tenantId, t.entryId], foreignColumns: [expenseWithholdings.tenantId, expenseWithholdings.id] }),
    index("challan_expense_entries_challan_idx").on(t.tenantId, t.challanId),
  ],
);

/** The income tax a payroll run deducted from pay (section 149) that a challan paid: each run once, whole, with the amount it was. */
export const challanPayrollRuns = pgTable(
  "challan_payroll_runs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    challanId: uuid("challan_id").notNull(),
    runId: uuid("run_id").notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
  },
  (t) => [
    unique("challan_payroll_runs_run_key").on(t.tenantId, t.runId),
    foreignKey({ name: "challan_payroll_runs_challan_fk", columns: [t.tenantId, t.challanId], foreignColumns: [withholdingChallans.tenantId, withholdingChallans.id] }),
    foreignKey({ name: "challan_payroll_runs_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRuns.tenantId, payrollRuns.id] }),
    index("challan_payroll_runs_challan_idx").on(t.tenantId, t.challanId),
  ],
);
