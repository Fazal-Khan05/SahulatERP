import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
import { accounts, journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { goodsReceiptLines } from "../purchasing/schema";
import { taxCategories, withholdingRules } from "../tax/schema";
import { branches, tenants } from "../tenant/schema";

// The supplier's bill: what the supplier asks to be paid, for goods already received or for a
// service or expense. Posting it is one act of the database: what was received leaves Goods
// received not invoiced, any difference between the bill and what the goods came in at goes to
// Purchase price differences, input tax is claimed where the law allows, tax is withheld where
// the company deducts it, and the rest is owed to the supplier in Trade payables.
//
// A draft is written, changed and thrown away by the app. The app's role cannot write a bill's
// status, its number, its journal, what a line cleared or the tax worked out on it; and it
// never writes a withholding entry.

const documentStamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

// What the company has chosen about buying. One row for a company, made when something is first
// chosen. `withholding_on`: the company deducts tax from what it pays its suppliers (the
// founder's decision, 2026-11-15: off until a company switches it on).
export const purchaseSettings = pgTable(
  "purchase_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    withholdingOn: boolean("withholding_on").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  () => [],
);

export const supplierBills = pgTable(
  "supplier_bills",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft or posted.
    status: text().notNull().default("draft"),
    // PB-2627-00001, taken when the bill is posted.
    number: text(),
    // The date on the supplier's invoice: the day the amount became owed.
    billDate: date("bill_date", { mode: "string" }).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    // The branch the bill belongs to: its goods were received into that branch's warehouses.
    branchId: uuid("branch_id").notNull(),
    // The number the supplier gave its invoice. One supplier's number is billed once.
    supplierInvoiceNo: text("supplier_invoice_no").notNull(),
    dueDate: date("due_date", { mode: "string" }),
    note: text(),
    // The withholding lines chosen for the bill, by their code in the tax tables; none where
    // nothing of that kind is deducted. Rates are never kept here: they are read from the
    // tables, for the bill's date, when the bill is posted.
    incomeTaxCode: text("income_tax_code"),
    salesTaxCode: text("sales_tax_code"),
    provincialTaxCode: text("provincial_tax_code"),
    // Written by the server from the lines; checked, and the taxes worked out, when it is posted.
    // amount: the lines before tax. sales_tax: input tax on them. provincial_tax: the province's
    // tax on services, charged by the supplier and withheld from it. total: all three.
    amount: numeric({ precision: 20, scale: 2 }).notNull().default("0"),
    salesTax: numeric("sales_tax", { precision: 20, scale: 2 }).notNull().default("0"),
    provincialTax: numeric("provincial_tax", { precision: 20, scale: 2 }).notNull().default("0"),
    total: numeric({ precision: 20, scale: 2 }).notNull().default("0"),
    // What was withheld, and what is left owed to the supplier: written when the bill is posted.
    withheld: numeric({ precision: 20, scale: 2 }).notNull().default("0"),
    payable: numeric({ precision: 20, scale: 2 }).notNull().default("0"),
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("supplier_bills_tenant_id_id_key").on(t.tenantId, t.id),
    unique("supplier_bills_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "supplier_bills_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "supplier_bills_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "supplier_bills_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("supplier_bills_tenant_date_idx").on(t.tenantId, t.billDate),
    index("supplier_bills_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("supplier_bills_status_known", sql`${t.status} in ('draft', 'posted')`),
    check("supplier_bills_number_format", sql`${t.number} ~ '^PB-[0-9]{4}-[0-9]{5,}$'`),
    check("supplier_bills_invoice_no_length", sql`char_length(btrim(${t.supplierInvoiceNo})) between 1 and 60`),
    check("supplier_bills_due_after_bill", sql`${t.dueDate} >= ${t.billDate}`),
    check("supplier_bills_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("supplier_bills_income_tax_code", sql`${t.incomeTaxCode} ~ '^income_tax\\.[a-z0-9_.]+$'`),
    check("supplier_bills_sales_tax_code", sql`${t.salesTaxCode} ~ '^sales_tax\\.[a-z0-9_.]+$'`),
    check("supplier_bills_provincial_tax_code", sql`${t.provincialTaxCode} ~ '^provincial_sales_tax\\.[a-z0-9_.]+$'`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check(
      "supplier_bills_amounts_sane",
      sql`${t.amount} >= 0 and ${t.amount} < 1e16 and ${t.salesTax} >= 0 and ${t.salesTax} < 1e16 and ${t.provincialTax} >= 0 and ${t.provincialTax} < 1e16 and ${t.withheld} >= 0 and ${t.withheld} < 1e16 and ${t.payable} >= 0 and ${t.payable} < 1e16`,
    ),
    check("supplier_bills_total_exact", sql`${t.total} = ${t.amount} + ${t.salesTax} + ${t.provincialTax}`),
    check("supplier_bills_payable_exact", sql`${t.status} = 'draft' or ${t.payable} = ${t.total} - ${t.withheld}`),
    check("supplier_bills_draft_is_bare", sql`${t.status} = 'posted' or (${t.withheld} = 0 and ${t.payable} = 0 and ${t.journalId} is null)`),
    check("supplier_bills_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`),
  ],
);

// One line of a bill. Either goods, billed against one line of a posted goods received note
// (so much of what arrived, at the supplier's price for one), or an expense or service, charged
// to an account. `received_value` is what the billed goods came into stock at, which leaves
// Goods received not invoiced; `sales_tax` is the input tax on the line at the rate in force on
// the bill's date for the line's tax category. Both are written when the bill is posted.
export const supplierBillLines = pgTable(
  "supplier_bill_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    billId: uuid("bill_id").notNull(),
    lineNo: integer("line_no").notNull(),
    // goods or expense.
    kind: text().notNull(),
    receiptLineId: uuid("receipt_line_id"),
    itemId: uuid("item_id"),
    accountId: uuid("account_id"),
    description: text().notNull(),
    // Goods: how much is billed, in the unit it was ordered in, and the supplier's price for one.
    quantity: numeric({ precision: 20, scale: 4 }),
    unitPrice: numeric("unit_price", { precision: 20, scale: 4 }),
    // What the line comes to before tax.
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    // The tax category the line is taxed under; none for a line that carries no sales tax.
    taxCategoryId: uuid("tax_category_id"),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }),
    salesTax: numeric("sales_tax", { precision: 20, scale: 2 }).notNull().default("0"),
    receivedValue: numeric("received_value", { precision: 20, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("supplier_bill_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("supplier_bill_lines_line_key").on(t.tenantId, t.billId, t.lineNo),
    // A line of goods received is on a bill once.
    unique("supplier_bill_lines_receipt_line_key").on(t.tenantId, t.billId, t.receiptLineId),
    foreignKey({ name: "supplier_bill_lines_bill_fk", columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
    foreignKey({ name: "supplier_bill_lines_receipt_line_fk", columns: [t.tenantId, t.receiptLineId], foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id] }),
    foreignKey({ name: "supplier_bill_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "supplier_bill_lines_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "supplier_bill_lines_tax_category_fk", columns: [t.tenantId, t.taxCategoryId], foreignColumns: [taxCategories.tenantId, taxCategories.id] }),
    index("supplier_bill_lines_tenant_receipt_line_idx").on(t.tenantId, t.receiptLineId),
    check("supplier_bill_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("supplier_bill_lines_kind_known", sql`${t.kind} in ('goods', 'expense')`),
    check(
      "supplier_bill_lines_kind_is_whole",
      sql`(${t.kind} = 'goods') = (${t.receiptLineId} is not null) and (${t.kind} = 'goods') = (${t.itemId} is not null) and (${t.kind} = 'goods') = (${t.quantity} is not null) and (${t.kind} = 'goods') = (${t.unitPrice} is not null) and (${t.kind} = 'expense') = (${t.accountId} is not null)`,
    ),
    check("supplier_bill_lines_description_length", sql`char_length(btrim(${t.description})) between 1 and 300`),
    check("supplier_bill_lines_quantity_positive", sql`${t.quantity} > 0 and ${t.quantity} < 1e12 and ${t.unitPrice} >= 0 and ${t.unitPrice} < 1e16`),
    check("supplier_bill_lines_amount_sane", sql`${t.amount} >= 0 and ${t.amount} < 1e16 and ${t.salesTax} >= 0 and ${t.salesTax} < 1e16`),
    // A line of goods comes to its quantity at the supplier's price, to the paisa.
    check("supplier_bill_lines_amount_exact", sql`${t.kind} = 'expense' or ${t.amount} = round(${t.quantity} * ${t.unitPrice}, 2)`),
    check("supplier_bill_lines_expense_has_amount", sql`${t.kind} = 'goods' or ${t.amount} > 0`),
    check("supplier_bill_lines_tax_needs_category", sql`${t.taxCategoryId} is not null or (${t.salesTax} = 0 and ${t.taxRate} is null)`),
    check("supplier_bill_lines_received_value_sane", sql`${t.receivedValue} >= 0 and ${t.receivedValue} < 1e16 and (${t.kind} = 'goods' or ${t.receivedValue} is null)`),
  ],
);

// Tax withheld from a supplier on one posted bill: which line of the withholding tables, on
// what amount, at what rate, and how much. Written only by the database when the bill is
// posted, and never changed. The challan it was paid to the government under is recorded
// later (Step 26).
export const withholdingEntries = pgTable(
  "withholding_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    billId: uuid("bill_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    // income_tax, sales_tax or provincial_sales_tax.
    kind: text().notNull(),
    // The dated row of the withholding tables the rate was read from, its code, and the law it cites.
    ruleId: uuid("rule_id").notNull(),
    code: text().notNull(),
    legalReference: text("legal_reference").notNull(),
    // Whether the supplier was on the Active Taxpayers List as recorded on that day.
    onActiveList: boolean("on_active_list").notNull(),
    baseAmount: numeric("base_amount", { precision: 20, scale: 2 }).notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    journalId: uuid("journal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("withholding_entries_tenant_id_id_key").on(t.tenantId, t.id),
    // One entry of each kind for a bill.
    unique("withholding_entries_bill_kind_key").on(t.tenantId, t.billId, t.kind),
    foreignKey({ name: "withholding_entries_bill_fk", columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
    foreignKey({ name: "withholding_entries_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "withholding_entries_rule_fk", columns: [t.tenantId, t.ruleId], foreignColumns: [withholdingRules.tenantId, withholdingRules.id] }),
    foreignKey({ name: "withholding_entries_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("withholding_entries_tenant_date_idx").on(t.tenantId, t.entryDate),
    index("withholding_entries_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("withholding_entries_kind_known", sql`${t.kind} in ('income_tax', 'sales_tax', 'provincial_sales_tax')`),
    check("withholding_entries_amounts_sane", sql`${t.baseAmount} > 0 and ${t.baseAmount} < 1e16 and ${t.rate} > 0 and ${t.rate} <= 100 and ${t.amount} > 0 and ${t.amount} < 1e16`),
    check("withholding_entries_amount_exact", sql`${t.amount} = round(${t.baseAmount} * ${t.rate} / 100, 2)`),
  ],
);
