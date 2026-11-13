import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { items, units } from "../items/schema";
import { customers } from "../parties/schema";
import { taxCategories } from "../tax/schema";
import { branches, memberships, tenants } from "../tenant/schema";
import { warehouses } from "../warehouses/schema";

// Every sales document is a row of one table: a quotation, an order, and later a delivery note,
// an invoice and a credit note. They share a header, lines and a life: a draft is changed and
// thrown away freely; submitting it takes its number (QT-2627-00001, SO-2627-00001) and from
// then on nothing about it or its lines changes. A submitted document is cancelled, never edited.
//
// An order can also wait: one that would take the customer over the credit limit is put on hold
// until the owner approves it with a reason, or sends it back.
//
// Amounts are in the document's currency. The tax figures on a line are the tax engine's answer
// for the document's date, stored so that a later change of rate never changes the document.
export const salesDocuments = pgTable(
  "sales_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // quotation, order, delivery, invoice or credit_note. Never changes.
    kind: text().notNull(),
    // draft, on_hold, submitted or cancelled.
    status: text().notNull().default("draft"),
    // Taken from the number series when the document is submitted; a draft has none.
    number: text(),
    documentDate: date("document_date", { mode: "string" }).notNull(),
    // A quotation's last day; nothing on other kinds.
    validUntil: date("valid_until", { mode: "string" }),
    customerId: uuid("customer_id").notNull(),
    // Where the goods leave from, and the branch that warehouse belongs to.
    warehouseId: uuid("warehouse_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    // The currency the amounts are in, and how many of the base currency one of it was worth.
    currency: text().notNull(),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 8 }).notNull().default("1"),
    // Whether the company charged sales tax when the lines were worked out, and whether its
    // prices already held the tax.
    taxed: boolean().notNull(),
    pricesIncludeTax: boolean("prices_include_tax").notNull(),
    // A sale the law takes out of further tax (SRO 648(I)/2013), such as to an end consumer.
    furtherTaxExcluded: boolean("further_tax_excluded").notNull().default(false),
    // The customer's own order number, and anything to say to the customer.
    customerReference: text("customer_reference"),
    notes: text(),
    // The document this one was made from and is checked against: for a delivery note, its
    // sales order. Nothing on a quotation or an order (an order made from a quotation is only
    // linked to it).
    sourceDocumentId: uuid("source_document_id"),
    // Whose sale it is: the salesperson with the largest share. A salesperson sees the
    // documents they wrote and the ones that are theirs.
    salespersonId: uuid("salesperson_id"),
    // What the lines come to. Written by the server from the lines, checked by the database on submit.
    grossTotal: numeric("gross_total", { precision: 20, scale: 4 }).notNull().default("0"),
    discountTotal: numeric("discount_total", { precision: 20, scale: 4 }).notNull().default("0"),
    valueTotal: numeric("value_total", { precision: 20, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 20, scale: 4 }).notNull().default("0"),
    furtherTaxTotal: numeric("further_tax_total", { precision: 20, scale: 4 }).notNull().default("0"),
    extraTaxTotal: numeric("extra_tax_total", { precision: 20, scale: 4 }).notNull().default("0"),
    total: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    // The buyer as it stood when the document was submitted, so the document reads the same
    // whatever is changed on the customer afterwards.
    buyerName: text("buyer_name"),
    buyerNtn: text("buyer_ntn"),
    buyerCnic: text("buyer_cnic"),
    buyerStrn: text("buyer_strn"),
    buyerRegistrationType: text("buyer_registration_type"),
    buyerAtlStatus: text("buyer_atl_status"),
    buyerProvince: text("buyer_province"),
    buyerAddress: text("buyer_address"),
    // On an order: the customer's limit and what the customer already owed and had on order
    // when it was submitted, written by the database. Over the limit, only an owner submits,
    // with a reason.
    creditLimit: numeric("credit_limit", { precision: 20, scale: 4 }),
    creditExposure: numeric("credit_exposure", { precision: 20, scale: 4 }),
    creditOverrideReason: text("credit_override_reason"),
    creditOverrideBy: uuid("credit_override_by"),
    // Set while an order waits for the owner.
    heldAt: timestamp("held_at", { withTimezone: true }),
    heldBy: uuid("held_by"),
    // For FBR digital invoicing, which is switched off until its module is built.
    fbrInvoiceNumber: text("fbr_invoice_number"),
    fbrSubmissionId: text("fbr_submission_id"),
    fbrStatus: text("fbr_status"),
    offlineFlag: boolean("offline_flag").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("sales_documents_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_documents_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "sales_documents_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "sales_documents_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "sales_documents_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "sales_documents_salesperson_fk", columns: [t.tenantId, t.salespersonId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    foreignKey({ name: "sales_documents_source_fk", columns: [t.tenantId, t.sourceDocumentId], foreignColumns: [t.tenantId, t.id] }),
    index("sales_documents_tenant_source_idx")
      .on(t.tenantId, t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
    check("sales_documents_source_only_for_followers", sql`${t.sourceDocumentId} is null or ${t.kind} in ('delivery', 'invoice', 'credit_note')`),
    check("sales_documents_not_own_source", sql`${t.sourceDocumentId} is distinct from ${t.id}`),
    index("sales_documents_tenant_kind_date_idx").on(t.tenantId, t.kind, t.documentDate),
    index("sales_documents_tenant_customer_idx").on(t.tenantId, t.customerId),
    check("sales_documents_kind_known", sql`${t.kind} in ('quotation', 'order', 'delivery', 'invoice', 'credit_note')`),
    check("sales_documents_status_known", sql`${t.status} in ('draft', 'on_hold', 'submitted', 'cancelled')`),
    check("sales_documents_number_format", sql`${t.number} ~ '^(QT|SO|DN|SI|CN)-[0-9]{4}-[0-9]{5,}$'`),
    check("sales_documents_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("sales_documents_exchange_rate_positive", sql`${t.exchangeRate} > 0 and ${t.exchangeRate} < 1e12`),
    check("sales_documents_valid_until_order", sql`${t.validUntil} >= ${t.documentDate}`),
    check("sales_documents_reference_length", sql`char_length(btrim(${t.customerReference})) between 1 and 60`),
    check("sales_documents_notes_length", sql`char_length(btrim(${t.notes})) between 1 and 1000`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check(
      "sales_documents_totals_sane",
      sql`${t.grossTotal} >= 0 and ${t.grossTotal} < 1e16 and ${t.discountTotal} >= 0 and ${t.discountTotal} < 1e16 and ${t.valueTotal} >= 0 and ${t.valueTotal} < 1e16 and ${t.taxTotal} >= 0 and ${t.taxTotal} < 1e16 and ${t.furtherTaxTotal} >= 0 and ${t.furtherTaxTotal} < 1e16 and ${t.extraTaxTotal} >= 0 and ${t.extraTaxTotal} < 1e16 and ${t.total} >= 0 and ${t.total} < 1e16`,
    ),
    check("sales_documents_total_adds_up", sql`${t.total} = ${t.valueTotal} + ${t.taxTotal} + ${t.furtherTaxTotal} + ${t.extraTaxTotal}`),
    check("sales_documents_untaxed_has_no_tax", sql`${t.taxed} or (${t.taxTotal} = 0 and ${t.furtherTaxTotal} = 0 and ${t.extraTaxTotal} = 0 and not ${t.pricesIncludeTax})`),
    // A draft or a waiting order has no number; a submitted or cancelled document has one, with who submitted it and the buyer as it stood.
    check(
      "sales_documents_submitted_is_whole",
      sql`(${t.status} in ('draft', 'on_hold')) = (${t.number} is null) and (${t.status} in ('draft', 'on_hold')) = (${t.submittedAt} is null) and (${t.status} in ('draft', 'on_hold')) = (${t.submittedBy} is null) and (${t.status} in ('draft', 'on_hold')) = (${t.buyerName} is null)`,
    ),
    check("sales_documents_held_is_whole", sql`(${t.status} = 'on_hold') = (${t.heldAt} is not null) and (${t.status} = 'on_hold') = (${t.heldBy} is not null) and (${t.status} <> 'on_hold' or ${t.kind} = 'order')`),
    check("sales_documents_cancelled_is_whole", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    check("sales_documents_cancel_reason_length", sql`char_length(btrim(${t.cancelReason})) between 3 and 300`),
    check("sales_documents_override_is_whole", sql`(${t.creditOverrideReason} is null) = (${t.creditOverrideBy} is null) and (${t.creditOverrideReason} is null or ${t.kind} = 'order')`),
    check("sales_documents_override_reason_length", sql`char_length(btrim(${t.creditOverrideReason})) between 3 and 300`),
  ],
);

// One line: so many of an item, in one of the item's units, at a price, less a discount, with
// the tax the engine worked out. `base_quantity` is the same quantity in the item's own unit,
// which is what stock is kept in.
export const salesLines = pgTable(
  "sales_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    // The item's name when the line was written, or what the user typed over it.
    description: text().notNull(),
    unitId: uuid("unit_id").notNull(),
    // How many of the item's own unit one of the unit sold holds; 1 for the item's own unit.
    unitFactor: numeric("unit_factor", { precision: 20, scale: 6 }).notNull().default("1"),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 4 }).notNull(),
    // What the price lists gave for one of the unit sold, and from which level; null when no
    // level had a price and the user typed one.
    listPrice: numeric("list_price", { precision: 20, scale: 4 }),
    priceSource: text("price_source"),
    // What was charged for one of the unit sold.
    unitPrice: numeric("unit_price", { precision: 20, scale: 4 }).notNull(),
    discountPercent: numeric("discount_percent", { precision: 7, scale: 4 }),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    taxCategoryId: uuid("tax_category_id"),
    taxKind: text("tax_kind"),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    // The day the rate that was used came into force.
    taxRateFrom: date("tax_rate_from", { mode: "string" }),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    furtherTaxRate: numeric("further_tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    furtherTaxAmount: numeric("further_tax_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    furtherTaxReason: text("further_tax_reason"),
    extraTaxAmount: numeric("extra_tax_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    // The item's retail price (one of its own unit, before tax) when the line was written, and
    // for Third Schedule goods the retail value the tax was worked on.
    retailPrice: numeric("retail_price", { precision: 20, scale: 4 }),
    retailPriceBase: numeric("retail_price_base", { precision: 20, scale: 4 }),
    saleType: text("sale_type"),
    sroScheduleNo: text("sro_schedule_no"),
    sroItemSerial: text("sro_item_serial"),
    fbrUomCode: text("fbr_uom_code"),
    hsCode: text("hs_code"),
    // On a delivery note: the line of the sales order that this line delivers.
    sourceLineId: uuid("source_line_id"),
    // The value of the supply before tax and after the discount, and what the buyer pays for the line.
    value: numeric({ precision: 20, scale: 4 }).notNull(),
    total: numeric({ precision: 20, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("sales_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_lines_line_key").on(t.tenantId, t.documentId, t.lineNo),
    // What a salesperson's share points at, so a share can never name another document's line.
    unique("sales_lines_document_line_key").on(t.tenantId, t.documentId, t.id),
    foreignKey({ name: "sales_lines_document_fk", columns: [t.tenantId, t.documentId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "sales_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "sales_lines_unit_fk", columns: [t.tenantId, t.unitId], foreignColumns: [units.tenantId, units.id] }),
    foreignKey({ name: "sales_lines_tax_category_fk", columns: [t.tenantId, t.taxCategoryId], foreignColumns: [taxCategories.tenantId, taxCategories.id] }),
    index("sales_lines_tenant_item_idx").on(t.tenantId, t.itemId),
    foreignKey({ name: "sales_lines_source_fk", columns: [t.tenantId, t.sourceLineId], foreignColumns: [t.tenantId, t.id] }),
    // A document delivers a line of its order on one line of its own, never two.
    uniqueIndex("sales_lines_document_source_key")
      .on(t.tenantId, t.documentId, t.sourceLineId)
      .where(sql`${t.sourceLineId} is not null`),
    index("sales_lines_tenant_source_idx")
      .on(t.tenantId, t.sourceLineId)
      .where(sql`${t.sourceLineId} is not null`),
    check("sales_lines_not_own_source", sql`${t.sourceLineId} is distinct from ${t.id}`),
    check("sales_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("sales_lines_description_length", sql`char_length(btrim(${t.description})) between 1 and 300`),
    check("sales_lines_quantity_positive", sql`${t.quantity} > 0 and ${t.quantity} < 1e12 and ${t.unitFactor} > 0 and ${t.unitFactor} < 1e12`),
    // The quantity in the item's own unit is exactly the quantity sold times the size of the unit sold.
    check("sales_lines_base_quantity_exact", sql`${t.baseQuantity} = ${t.quantity} * ${t.unitFactor}`),
    check("sales_lines_price_sane", sql`${t.unitPrice} >= 0 and ${t.unitPrice} < 1e16 and coalesce(${t.listPrice}, 0) >= 0 and coalesce(${t.listPrice}, 0) < 1e16`),
    check("sales_lines_price_source_known", sql`${t.priceSource} in ('customer', 'class', 'list', 'item')`),
    check("sales_lines_list_price_pair", sql`(${t.listPrice} is null) = (${t.priceSource} is null)`),
    check("sales_lines_discount_sane", sql`${t.discountAmount} >= 0 and ${t.discountAmount} < 1e16 and coalesce(${t.discountPercent}, 0) between 0 and 100`),
    check(
      "sales_lines_amounts_sane",
      sql`${t.value} >= 0 and ${t.value} < 1e16 and ${t.taxAmount} >= 0 and ${t.taxAmount} < 1e16 and ${t.furtherTaxAmount} >= 0 and ${t.furtherTaxAmount} < 1e16 and ${t.extraTaxAmount} >= 0 and ${t.extraTaxAmount} < 1e16 and ${t.total} >= 0 and ${t.total} < 1e16 and coalesce(${t.retailPrice}, 0) >= 0 and coalesce(${t.retailPrice}, 0) < 1e16 and coalesce(${t.retailPriceBase}, 0) >= 0 and coalesce(${t.retailPriceBase}, 0) < 1e16`,
    ),
    check("sales_lines_rates_sane", sql`${t.taxRate} between 0 and 100 and ${t.furtherTaxRate} between 0 and 100`),
    check("sales_lines_total_adds_up", sql`${t.total} = ${t.value} + ${t.taxAmount} + ${t.furtherTaxAmount} + ${t.extraTaxAmount}`),
    check("sales_lines_tax_kind_known", sql`${t.taxKind} in ('standard', 'reduced', 'third_schedule', 'zero_rated', 'exempt')`),
    check("sales_lines_further_tax_reason_known", sql`${t.furtherTaxReason} in ('buyer_unregistered', 'buyer_inactive', 'buyer_not_checked')`),
  ],
);

// Who sold a line, and what share of it is theirs. A line has no shares at all, or shares that
// come to exactly 100; the database checks that when the document is submitted.
export const salesLineSalespeople = pgTable(
  "sales_line_salespeople",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: uuid("document_id").notNull(),
    lineId: uuid("line_id").notNull(),
    userId: uuid("user_id").notNull(),
    sharePercent: numeric("share_percent", { precision: 7, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("sales_line_salespeople_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_line_salespeople_line_user_key").on(t.tenantId, t.lineId, t.userId),
    foreignKey({ name: "sales_line_salespeople_line_fk", columns: [t.tenantId, t.documentId, t.lineId], foreignColumns: [salesLines.tenantId, salesLines.documentId, salesLines.id] }),
    foreignKey({ name: "sales_line_salespeople_member_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index("sales_line_salespeople_tenant_user_idx").on(t.tenantId, t.userId),
    check("sales_line_salespeople_share_range", sql`${t.sharePercent} > 0 and ${t.sharePercent} <= 100`),
  ],
);

// Which document was made from which: an order from a quotation, and later a delivery from an
// order and an invoice from either.
export const salesDocumentLinks = pgTable(
  "sales_document_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fromDocumentId: uuid("from_document_id").notNull(),
    toDocumentId: uuid("to_document_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("sales_document_links_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_document_links_pair_key").on(t.tenantId, t.fromDocumentId, t.toDocumentId),
    foreignKey({ name: "sales_document_links_from_fk", columns: [t.tenantId, t.fromDocumentId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "sales_document_links_to_fk", columns: [t.tenantId, t.toDocumentId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    index("sales_document_links_tenant_to_idx").on(t.tenantId, t.toDocumentId),
    check("sales_document_links_not_self", sql`${t.fromDocumentId} <> ${t.toDocumentId}`),
  ],
);
