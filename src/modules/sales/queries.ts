import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { isIsoDate } from "@/modules/currencies/rules";
import { currencies } from "@/modules/currencies/schema";
import { itemUnits, items, units } from "@/modules/items/schema";
import { customers, partyAddresses } from "@/modules/parties/schema";
import { selectPricesFor } from "@/modules/prices/queries";
import type { PriceSource } from "@/modules/prices/rules";
import { companySetup } from "@/modules/setup/schema";
import { selectSalesTaxTables } from "@/modules/tax/queries";
import type { FurtherTaxReason, TaxCategoryKind } from "@/modules/tax/rules";
import { can, type MemberRole, type TenantContext } from "@/modules/tenant/rules";
import { branches } from "@/modules/tenant/schema";
import { warehouses } from "@/modules/warehouses/schema";
import { selectMoveCosts, selectStockOnHand } from "@/modules/inventory/queries";
import { type CreditFacts, type DraftLine, type LineItem, type ListPrice, type OrderLineToDeliver, type PricedLine, type SalesKind, type SalesStatus, type Share, type TaxContext, isSalesKind } from "./rules";
import { salesDocumentLinks, salesDocuments, salesLineSalespeople, salesLines } from "./schema";

const sourceDocuments = alias(salesDocuments, "source_documents");

export function requireSalesAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "sales.read")) throw new UserError("Your role does not include sales documents.");
}

/** For what the warehouse reads too: delivery notes, and the orders they are made from. */
export function requireDocumentAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "sales.read") && !can(ctx.role, "delivery.read")) throw new UserError("Your role does not include sales documents.");
}

export type StoredLine = {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  description: string;
  unitId: string;
  unitCode: string;
  unitFactor: Decimal;
  quantity: Decimal;
  baseQuantity: Decimal;
  listPrice: Decimal | null;
  priceSource: PriceSource | null;
  unitPrice: Decimal;
  discountPercent: Decimal | null;
  discountAmount: Decimal;
  taxKind: TaxCategoryKind | null;
  taxRate: Decimal;
  taxAmount: Decimal;
  furtherTaxRate: Decimal;
  furtherTaxAmount: Decimal;
  furtherTaxReason: FurtherTaxReason;
  extraTaxAmount: Decimal;
  value: Decimal;
  total: Decimal;
  /** On a delivery note: the line of the order this line delivers. */
  sourceLineId: string | null;
};

export type SalesDocument = {
  id: string;
  kind: SalesKind;
  status: SalesStatus;
  number: string | null;
  date: string;
  validUntil: string | null;
  customerId: string;
  /** The customer's name: as it stood when the document was submitted, or as it is now for a draft. */
  customerName: string;
  customerArchived: boolean;
  warehouseId: string;
  warehouseName: string;
  branchId: string;
  currency: string;
  exchangeRate: Decimal;
  taxed: boolean;
  pricesIncludeTax: boolean;
  furtherTaxExcluded: boolean;
  customerReference: string | null;
  notes: string | null;
  salespersonId: string | null;
  totals: { gross: Decimal; discount: Decimal; value: Decimal; tax: Decimal; furtherTax: Decimal; extraTax: Decimal; total: Decimal };
  creditLimit: Decimal | null;
  creditExposure: Decimal | null;
  creditOverrideReason: string | null;
  cancelReason: string | null;
  /** What a delivery note or an invoice was made from: a sales order, or for an invoice perhaps a delivery note. */
  source: { id: string; kind: SalesKind; number: string | null; date: string; sourceDocumentId: string | null } | null;
  /** On a posted invoice: the day it falls due. */
  dueDate: string | null;
  createdBy: string;
  updatedAt: Date;
  lines: StoredLine[];
  /** The salespeople's shares, the same on every line. */
  shares: Share[];
};

const exact = (value: string | null) => (value === null ? null : new Decimal(value));

/**
 * One sales document with its lines and shares, inside a transaction the caller already holds.
 * Null when it is not this company's, or not one this member may see. `lock` holds the row.
 */
export async function selectSalesDocument(tx: Tx, tenantId: string, id: string, lock?: "update"): Promise<SalesDocument | null> {
  const header = tx
    .select({
      id: salesDocuments.id,
      kind: salesDocuments.kind,
      status: salesDocuments.status,
      number: salesDocuments.number,
      date: salesDocuments.documentDate,
      validUntil: salesDocuments.validUntil,
      customerId: salesDocuments.customerId,
      warehouseId: salesDocuments.warehouseId,
      branchId: salesDocuments.branchId,
      currency: salesDocuments.currency,
      exchangeRate: salesDocuments.exchangeRate,
      taxed: salesDocuments.taxed,
      pricesIncludeTax: salesDocuments.pricesIncludeTax,
      furtherTaxExcluded: salesDocuments.furtherTaxExcluded,
      customerReference: salesDocuments.customerReference,
      notes: salesDocuments.notes,
      salespersonId: salesDocuments.salespersonId,
      grossTotal: salesDocuments.grossTotal,
      discountTotal: salesDocuments.discountTotal,
      valueTotal: salesDocuments.valueTotal,
      taxTotal: salesDocuments.taxTotal,
      furtherTaxTotal: salesDocuments.furtherTaxTotal,
      extraTaxTotal: salesDocuments.extraTaxTotal,
      total: salesDocuments.total,
      buyerName: salesDocuments.buyerName,
      creditLimit: salesDocuments.creditLimit,
      creditExposure: salesDocuments.creditExposure,
      creditOverrideReason: salesDocuments.creditOverrideReason,
      cancelReason: salesDocuments.cancelReason,
      sourceDocumentId: salesDocuments.sourceDocumentId,
      dueDate: salesDocuments.dueDate,
      createdBy: salesDocuments.createdBy,
      updatedAt: salesDocuments.updatedAt,
    })
    .from(salesDocuments)
    .where(and(eq(salesDocuments.tenantId, tenantId), eq(salesDocuments.id, id)));
  const [row] = lock ? await header.for("update") : await header;
  if (!row || !isSalesKind(row.kind)) return null;
  const [[customer], [warehouse], [source], lineRows, shareRows] = await Promise.all([
    tx.select({ name: customers.name, archivedAt: customers.archivedAt }).from(customers).where(and(eq(customers.tenantId, tenantId), eq(customers.id, row.customerId))),
    tx.select({ name: warehouses.name }).from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, row.warehouseId))),
    row.sourceDocumentId === null
      ? Promise.resolve([])
      : tx.select({ id: sourceDocuments.id, kind: sourceDocuments.kind, number: sourceDocuments.number, date: sourceDocuments.documentDate, buyerName: sourceDocuments.buyerName, sourceDocumentId: sourceDocuments.sourceDocumentId }).from(sourceDocuments).where(and(eq(sourceDocuments.tenantId, tenantId), eq(sourceDocuments.id, row.sourceDocumentId))),
    tx
      .select({
        id: salesLines.id,
        lineNo: salesLines.lineNo,
        itemId: salesLines.itemId,
        itemCode: items.code,
        description: salesLines.description,
        unitId: salesLines.unitId,
        unitCode: units.code,
        unitFactor: salesLines.unitFactor,
        quantity: salesLines.quantity,
        baseQuantity: salesLines.baseQuantity,
        listPrice: salesLines.listPrice,
        priceSource: salesLines.priceSource,
        unitPrice: salesLines.unitPrice,
        discountPercent: salesLines.discountPercent,
        discountAmount: salesLines.discountAmount,
        taxKind: salesLines.taxKind,
        taxRate: salesLines.taxRate,
        taxAmount: salesLines.taxAmount,
        furtherTaxRate: salesLines.furtherTaxRate,
        furtherTaxAmount: salesLines.furtherTaxAmount,
        furtherTaxReason: salesLines.furtherTaxReason,
        extraTaxAmount: salesLines.extraTaxAmount,
        value: salesLines.value,
        total: salesLines.total,
        sourceLineId: salesLines.sourceLineId,
      })
      .from(salesLines)
      .innerJoin(items, and(eq(items.tenantId, salesLines.tenantId), eq(items.id, salesLines.itemId)))
      .innerJoin(units, and(eq(units.tenantId, salesLines.tenantId), eq(units.id, salesLines.unitId)))
      .where(and(eq(salesLines.tenantId, tenantId), eq(salesLines.documentId, id)))
      .orderBy(asc(salesLines.lineNo)),
    // Every line carries the same shares; the first line's are the document's.
    tx
      .select({ userId: salesLineSalespeople.userId, percent: salesLineSalespeople.sharePercent })
      .from(salesLineSalespeople)
      .innerJoin(salesLines, and(eq(salesLines.tenantId, salesLineSalespeople.tenantId), eq(salesLines.id, salesLineSalespeople.lineId)))
      .where(and(eq(salesLineSalespeople.tenantId, tenantId), eq(salesLineSalespeople.documentId, id), eq(salesLines.lineNo, 1)))
      .orderBy(desc(salesLineSalespeople.sharePercent), asc(salesLineSalespeople.createdAt), asc(salesLineSalespeople.id)),
  ]);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as SalesStatus,
    number: row.number,
    date: row.date,
    validUntil: row.validUntil,
    customerId: row.customerId,
    // The warehouse does not read customers: a draft delivery note takes the name its order kept.
    customerName: row.buyerName ?? customer?.name ?? source?.buyerName ?? "",
    customerArchived: customer?.archivedAt != null,
    warehouseId: row.warehouseId,
    warehouseName: warehouse?.name ?? "",
    branchId: row.branchId,
    currency: row.currency,
    exchangeRate: new Decimal(row.exchangeRate),
    taxed: row.taxed,
    pricesIncludeTax: row.pricesIncludeTax,
    furtherTaxExcluded: row.furtherTaxExcluded,
    customerReference: row.customerReference,
    notes: row.notes,
    salespersonId: row.salespersonId,
    totals: {
      gross: new Decimal(row.grossTotal),
      discount: new Decimal(row.discountTotal),
      value: new Decimal(row.valueTotal),
      tax: new Decimal(row.taxTotal),
      furtherTax: new Decimal(row.furtherTaxTotal),
      extraTax: new Decimal(row.extraTaxTotal),
      total: new Decimal(row.total),
    },
    creditLimit: exact(row.creditLimit),
    creditExposure: exact(row.creditExposure),
    creditOverrideReason: row.creditOverrideReason,
    cancelReason: row.cancelReason,
    source: source && isSalesKind(source.kind) ? { id: source.id, kind: source.kind, number: source.number, date: source.date, sourceDocumentId: source.sourceDocumentId } : null,
    dueDate: row.dueDate,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    lines: lineRows.map((line) => ({
      ...line,
      unitFactor: new Decimal(line.unitFactor),
      quantity: new Decimal(line.quantity),
      baseQuantity: new Decimal(line.baseQuantity),
      listPrice: exact(line.listPrice),
      priceSource: line.priceSource as PriceSource | null,
      unitPrice: new Decimal(line.unitPrice),
      discountPercent: exact(line.discountPercent),
      discountAmount: new Decimal(line.discountAmount),
      taxKind: line.taxKind as TaxCategoryKind | null,
      taxRate: new Decimal(line.taxRate),
      taxAmount: new Decimal(line.taxAmount),
      furtherTaxRate: new Decimal(line.furtherTaxRate),
      furtherTaxAmount: new Decimal(line.furtherTaxAmount),
      furtherTaxReason: line.furtherTaxReason as FurtherTaxReason,
      extraTaxAmount: new Decimal(line.extraTaxAmount),
      value: new Decimal(line.value),
      total: new Decimal(line.total),
    })),
    shares: shareRows.map((share) => ({ userId: share.userId, percent: new Decimal(share.percent) })),
  };
}

export type LinkedDocument = { id: string; kind: SalesKind; number: string | null; status: SalesStatus };

/** One sales document, with the documents it was made from and the ones made from it. */
export async function getSalesDocument(ctx: TenantContext, id: string): Promise<(SalesDocument & { madeFrom: LinkedDocument[]; madeInto: LinkedDocument[] }) | null> {
  requireDocumentAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const document = await selectSalesDocument(tx, ctx.tenantId, id);
    if (!document) return null;
    const linked = { id: salesDocuments.id, kind: salesDocuments.kind, number: salesDocuments.number, status: salesDocuments.status };
    const [madeFrom, madeInto] = await Promise.all([
      tx
        .select(linked)
        .from(salesDocumentLinks)
        .innerJoin(salesDocuments, and(eq(salesDocuments.tenantId, salesDocumentLinks.tenantId), eq(salesDocuments.id, salesDocumentLinks.fromDocumentId)))
        .where(and(eq(salesDocumentLinks.tenantId, ctx.tenantId), eq(salesDocumentLinks.toDocumentId, id))),
      tx
        .select(linked)
        .from(salesDocumentLinks)
        .innerJoin(salesDocuments, and(eq(salesDocuments.tenantId, salesDocumentLinks.tenantId), eq(salesDocuments.id, salesDocumentLinks.toDocumentId)))
        .where(and(eq(salesDocumentLinks.tenantId, ctx.tenantId), eq(salesDocumentLinks.fromDocumentId, id)))
        .orderBy(asc(salesDocuments.createdAt)),
    ]);
    const known = (rows: { id: string; kind: string; number: string | null; status: string }[]) => rows.filter((row): row is LinkedDocument => isSalesKind(row.kind));
    return { ...document, madeFrom: known(madeFrom), madeInto: known(madeInto) };
  });
}

export const SALES_LIST_LIMIT = 200;

export type SalesListRow = { id: string; kind: SalesKind; status: SalesStatus; number: string | null; date: string; customerName: string; total: Decimal; currency: string };

/** The newest documents of one kind, drafts first among those of the same day. `search` matches part of the number or the customer's name. */
export async function listSalesDocuments(ctx: TenantContext, options: { kind: SalesKind; status?: SalesStatus | null; search?: string }): Promise<{ rows: SalesListRow[]; more: boolean }> {
  if (options.kind === "quotation" || options.kind === "invoice") requireSalesAccess(ctx);
  else requireDocumentAccess(ctx);
  const term = (options.search ?? "").replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80);
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const matches: SQL | undefined = term === "" ? undefined : sql`(${salesDocuments.number} ilike ${pattern} or ${customers.name} ilike ${pattern} or ${salesDocuments.buyerName} ilike ${pattern} or ${sourceDocuments.buyerName} ilike ${pattern})`;
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: salesDocuments.id,
        kind: salesDocuments.kind,
        status: salesDocuments.status,
        number: salesDocuments.number,
        date: salesDocuments.documentDate,
        customerName: sql<string>`coalesce(${salesDocuments.buyerName}, ${customers.name}, ${sourceDocuments.buyerName}, '')`,
        total: salesDocuments.total,
        currency: salesDocuments.currency,
      })
      .from(salesDocuments)
      // Left joins: the warehouse reads delivery notes but not customers.
      .leftJoin(customers, and(eq(customers.tenantId, salesDocuments.tenantId), eq(customers.id, salesDocuments.customerId)))
      .leftJoin(sourceDocuments, and(eq(sourceDocuments.tenantId, salesDocuments.tenantId), eq(sourceDocuments.id, salesDocuments.sourceDocumentId)))
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.kind, options.kind), options.status ? eq(salesDocuments.status, options.status) : undefined, matches))
      .orderBy(desc(salesDocuments.documentDate), desc(salesDocuments.createdAt))
      .limit(SALES_LIST_LIMIT + 1),
  );
  return {
    more: found.length > SALES_LIST_LIMIT,
    rows: found.slice(0, SALES_LIST_LIMIT).map((row) => ({ ...row, kind: row.kind as SalesKind, status: row.status as SalesStatus, total: new Decimal(row.total) })),
  };
}

/** Orders waiting for the owner's approval, oldest first: what the owner's inbox shows. */
export async function listOrdersOnHold(ctx: TenantContext): Promise<{ id: string; customerName: string; total: Decimal; date: string }[]> {
  if (!can(ctx.role, "sales.read")) return [];
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: salesDocuments.id, customerName: customers.name, total: salesDocuments.total, date: salesDocuments.documentDate })
      .from(salesDocuments)
      .innerJoin(customers, and(eq(customers.tenantId, salesDocuments.tenantId), eq(customers.id, salesDocuments.customerId)))
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.status, "on_hold")))
      .orderBy(asc(salesDocuments.heldAt))
      .limit(100),
  );
  return rows.map((row) => ({ ...row, total: new Decimal(row.total) }));
}

// ── What a document is worked out from ──────────────────────────────────────────────────────────

/** The company's base currency, in which sales documents are written until foreign-currency sales exist. */
export async function selectBaseCurrency(tx: Tx, tenantId: string): Promise<string | null> {
  const [row] = await tx.select({ code: currencies.code }).from(currencies).where(and(eq(currencies.tenantId, tenantId), eq(currencies.isBase, true)));
  return row?.code ?? null;
}

export type SalesCustomer = {
  id: string;
  name: string;
  archived: boolean;
  registrationType: "registered" | "unregistered";
  atlStatus: "unknown" | "active" | "inactive";
  ntn: string | null;
  cnic: string | null;
  strn: string | null;
  province: string | null;
  address: string | null;
};

export async function selectSalesCustomer(tx: Tx, tenantId: string, id: string): Promise<SalesCustomer | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx
    .select({
      id: customers.id,
      name: customers.name,
      archivedAt: customers.archivedAt,
      registrationType: customers.registrationType,
      atlStatus: customers.atlStatus,
      ntn: customers.ntn,
      cnic: customers.cnic,
      strn: customers.strn,
      province: customers.province,
      line: partyAddresses.line,
      city: partyAddresses.city,
    })
    .from(customers)
    .leftJoin(partyAddresses, and(eq(partyAddresses.tenantId, customers.tenantId), eq(partyAddresses.customerId, customers.id), eq(partyAddresses.isPrimary, true)))
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)));
  if (!row) return null;
  const { archivedAt, line, city, ...customer } = row;
  return { ...customer, archived: archivedAt !== null, address: [line, city].filter(Boolean).join(", ") || null };
}

/** What every line of a document shares for tax: who sells, who buys, when, and the dated rates. */
export async function selectTaxContext(tx: Tx, tenantId: string, facts: { customer: SalesCustomer; date: string; currency: string; furtherTaxExcluded: boolean }): Promise<{ context: TaxContext; categories: Awaited<ReturnType<typeof selectSalesTaxTables>>["categories"] }> {
  const [[setup], tables] = await Promise.all([
    tx.select({ salesTaxRegistered: companySetup.salesTaxRegistered, pricesIncludeTax: companySetup.pricesIncludeTax }).from(companySetup).where(eq(companySetup.tenantId, tenantId)),
    selectSalesTaxTables(tx, tenantId),
  ]);
  const registered = setup?.salesTaxRegistered ?? false;
  return {
    categories: tables.categories,
    context: {
      // A company that charges no sales tax has no tax inside its prices either.
      seller: { salesTaxRegistered: registered, pricesIncludeTax: registered && (setup?.pricesIncludeTax ?? false) },
      buyer: { registrationType: facts.customer.registrationType, atlStatus: facts.customer.atlStatus, furtherTaxExcluded: facts.furtherTaxExcluded },
      date: facts.date,
      currency: facts.currency,
      rates: tables.rates,
      standardCategory: tables.standardCategory,
    },
  };
}

/** The items on a document's lines, with their units, and the price lists' price of each for the customer. */
export async function selectLineItems(
  tx: Tx,
  tenantId: string,
  query: { itemIds: readonly string[]; customerId: string; date: string; categories: Awaited<ReturnType<typeof selectSalesTaxTables>>["categories"] },
): Promise<{ items: Map<string, LineItem>; prices: Map<string, ListPrice> }> {
  const itemIds = [...new Set(query.itemIds)].filter(isUuid);
  if (itemIds.length === 0) return { items: new Map(), prices: new Map() };
  const [itemRows, conversionRows, prices] = await Promise.all([
    tx
      .select({ id: items.id, code: items.code, name: items.name, archivedAt: items.archivedAt, baseUnitId: items.baseUnitId, taxCategoryId: items.taxCategoryId, retailPrice: items.retailPrice, saleType: items.saleType, fbrUomCode: items.fbrUomCode, hsCode: items.hsCode })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), inArray(items.id, itemIds))),
    tx.select({ itemId: itemUnits.itemId, unitId: itemUnits.unitId, factor: itemUnits.factor }).from(itemUnits).where(and(eq(itemUnits.tenantId, tenantId), inArray(itemUnits.itemId, itemIds))),
    selectPricesFor(tx, tenantId, { customerId: query.customerId, itemIds, date: query.date }),
  ]);
  const found = new Map<string, LineItem>();
  for (const row of itemRows) {
    found.set(row.id, {
      id: row.id,
      code: row.code,
      name: row.name,
      archived: row.archivedAt !== null,
      baseUnitId: row.baseUnitId,
      conversions: conversionRows.filter((c) => c.itemId === row.id).map((c) => ({ unitId: c.unitId, factor: new Decimal(c.factor) })),
      taxCategory: row.taxCategoryId === null ? null : (query.categories.get(row.taxCategoryId) ?? null),
      retailPrice: exact(row.retailPrice),
      saleType: row.saleType,
      fbrUomCode: row.fbrUomCode,
      hsCode: row.hsCode,
    });
  }
  return { items: found, prices };
}

/** A stored line as the typed line it came from, to be worked out again. */
export function asDraftLine(line: Pick<StoredLine, "itemId" | "description" | "unitId" | "quantity" | "unitPrice" | "discountPercent">): DraftLine {
  return { itemId: line.itemId, description: line.description, unitId: line.unitId, quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent };
}

/** True when a line worked out now is the line that was stored: same list price, price, discount and tax, to the paisa. */
export function sameAsStored(stored: StoredLine, priced: PricedLine): boolean {
  return (
    stored.baseQuantity.eq(priced.baseQuantity) &&
    // The price lists' price is part of what was shown: a list that has moved since is a change.
    (stored.listPrice === null ? priced.listPrice === null : priced.listPrice !== null && stored.listPrice.eq(priced.listPrice)) &&
    stored.unitPrice.eq(priced.unitPrice) &&
    stored.discountAmount.eq(priced.discountAmount) &&
    stored.value.eq(priced.value) &&
    stored.taxRate.eq(priced.taxRate) &&
    stored.taxAmount.eq(priced.taxAmount) &&
    stored.furtherTaxRate.eq(priced.furtherTaxRate) &&
    stored.furtherTaxAmount.eq(priced.furtherTaxAmount) &&
    stored.extraTaxAmount.eq(priced.extraTaxAmount) &&
    stored.total.eq(priced.total)
  );
}

// ── The credit limit ────────────────────────────────────────────────────────────────────────────

/** A customer's limit, what the books say it owes, and its other submitted orders. Null when it is not this company's. */
export async function selectCustomerCredit(tx: Tx, customerId: string, exceptDocumentId: string | null): Promise<CreditFacts | null> {
  const rows = await tx.execute<{ credit_limit: string | null; receivable: string; open_orders: string }>(
    sql`select credit_limit::text, receivable::text, open_orders::text from app.customer_credit(${customerId}::uuid, ${exceptDocumentId}::uuid)`,
  );
  const row = rows[0];
  return row ? { limit: exact(row.credit_limit), receivable: new Decimal(row.receivable), openOrders: new Decimal(row.open_orders) } : null;
}

export async function getCustomerCredit(ctx: TenantContext, customerId: string, exceptDocumentId: string | null = null): Promise<CreditFacts | null> {
  requireSalesAccess(ctx);
  if (!isUuid(customerId) || (exceptDocumentId !== null && !isUuid(exceptDocumentId))) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectCustomerCredit(tx, customerId, exceptDocumentId));
}

// ── What the form offers ────────────────────────────────────────────────────────────────────────

export type SalesPerson = { userId: string; email: string; role: MemberRole };

/** The members a sale can be credited to: active owners, sales managers and salespeople, by email. */
export async function selectSalesPeople(tx: Tx): Promise<SalesPerson[]> {
  const rows = await tx.execute<{ user_id: string; email: string; role: MemberRole }>(sql`select user_id, email, role from app.sales_people() order by email`);
  return rows.map((row) => ({ userId: row.user_id, email: row.email, role: row.role }));
}

export async function listSalesPeople(ctx: TenantContext): Promise<SalesPerson[]> {
  requireSalesAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectSalesPeople(tx));
}

export type Choice = { id: string; label: string; sub?: string };

const likePattern = (typed: string) => `%${typed.replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80).replace(/[\\%_]/g, "\\$&")}%`;

/** Customers that can be sold to, matching part of the code or name: for the form's picker. */
export async function searchCustomers(ctx: TenantContext, typed: string): Promise<Choice[]> {
  requireSalesAccess(ctx);
  const pattern = likePattern(typed);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: customers.id, code: customers.code, name: customers.name })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenantId), isNull(customers.archivedAt), or(sql`${customers.name} ilike ${pattern}`, sql`${customers.code} ilike ${pattern}`)))
      .orderBy(asc(sql`lower(${customers.name})`))
      .limit(10),
  );
  return rows.map((row) => ({ id: row.id, label: row.name, sub: row.code ?? undefined }));
}

/** Items that can be sold, matching part of the code or name; a code typed in full comes first. */
export async function searchItems(ctx: TenantContext, typed: string): Promise<Choice[]> {
  requireSalesAccess(ctx);
  const pattern = likePattern(typed);
  const whole = typed.trim().toLowerCase();
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: items.id, code: items.code, name: items.name })
      .from(items)
      .where(and(eq(items.tenantId, ctx.tenantId), isNull(items.archivedAt), or(sql`${items.code} ilike ${pattern}`, sql`${items.name} ilike ${pattern}`)))
      .orderBy(desc(sql`lower(${items.code}) = ${whole}`), asc(sql`lower(${items.code})`))
      .limit(10),
  );
  return rows.map((row) => ({ id: row.id, label: row.code, sub: row.name }));
}

export type LineDefaults = {
  itemId: string;
  code: string;
  name: string;
  /** The units the item is sold in, its own first; one of each holds `factor` of its own. */
  units: { id: string; code: string; factor: string }[];
  /** The price lists' price of one of the item's own unit for the customer, when there is one. */
  listPrice: string | null;
};

/** What a line starts from when an item is chosen: its name, its units and the customer's price for it. */
export async function getLineDefaults(ctx: TenantContext, query: { itemId: string; customerId: string | null; date: string }): Promise<LineDefaults | null> {
  requireSalesAccess(ctx);
  if (!isUuid(query.itemId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [[item], conversions] = await Promise.all([
      tx
        .select({ id: items.id, code: items.code, name: items.name, baseUnitId: items.baseUnitId, baseUnitCode: units.code, defaultPrice: items.defaultPrice })
        .from(items)
        .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
        .where(and(eq(items.tenantId, ctx.tenantId), eq(items.id, query.itemId))),
      tx
        .select({ id: itemUnits.unitId, code: units.code, factor: itemUnits.factor })
        .from(itemUnits)
        .innerJoin(units, and(eq(units.tenantId, itemUnits.tenantId), eq(units.id, itemUnits.unitId)))
        .where(and(eq(itemUnits.tenantId, ctx.tenantId), eq(itemUnits.itemId, query.itemId)))
        .orderBy(asc(itemUnits.factor)),
    ]);
    if (!item) return null;
    let listPrice: string | null = item.defaultPrice;
    if (query.customerId !== null && isUuid(query.customerId) && isIsoDate(query.date)) {
      const prices = await selectPricesFor(tx, ctx.tenantId, { customerId: query.customerId, itemIds: [item.id], date: query.date });
      listPrice = prices.get(item.id)?.price.toFixed() ?? null;
    }
    return { itemId: item.id, code: item.code, name: item.name, units: [{ id: item.baseUnitId, code: item.baseUnitCode, factor: "1" }, ...conversions], listPrice };
  });
}

/** The warehouses this member may sell from, with their branches. */
export async function listSalesWarehouses(ctx: TenantContext): Promise<{ id: string; name: string; branchId: string }[]> {
  requireSalesAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: warehouses.id, name: warehouses.name, branchId: warehouses.branchId })
      .from(warehouses)
      .innerJoin(branches, and(eq(branches.tenantId, warehouses.tenantId), eq(branches.id, warehouses.branchId)))
      .where(eq(warehouses.tenantId, ctx.tenantId))
      .orderBy(asc(warehouses.createdAt)),
  );
}

// ── Delivery notes ──────────────────────────────────────────────────────────────────────────────

/**
 * The lines of a sales order as a delivery note or an invoice needs them, with how much of each
 * has already left the warehouse (posted delivery notes, and invoices made straight from the
 * order) and how much has been invoiced, inside a transaction the caller holds. Quantities are
 * in the unit each line was sold in.
 */
export async function selectOrderLinesToDeliver(tx: Tx, tenantId: string, orderId: string): Promise<(OrderLineToDeliver & { lineNo: number; unitCode: string; invoiced: Decimal })[]> {
  const [lines, delivered] = await Promise.all([
    tx
      .select({
        id: salesLines.id,
        lineNo: salesLines.lineNo,
        itemId: salesLines.itemId,
        itemCode: items.code,
        description: salesLines.description,
        unitId: salesLines.unitId,
        unitCode: units.code,
        unitFactor: salesLines.unitFactor,
        quantity: salesLines.quantity,
        unitPrice: salesLines.unitPrice,
        listPrice: salesLines.listPrice,
        priceSource: salesLines.priceSource,
        discountPercent: salesLines.discountPercent,
      })
      .from(salesLines)
      .innerJoin(items, and(eq(items.tenantId, salesLines.tenantId), eq(items.id, salesLines.itemId)))
      .innerJoin(units, and(eq(units.tenantId, salesLines.tenantId), eq(units.id, salesLines.unitId)))
      .where(and(eq(salesLines.tenantId, tenantId), eq(salesLines.documentId, orderId)))
      .orderBy(asc(salesLines.lineNo)),
    // Asked of the database's own function: the same figure for everyone who may see the order,
    // whoever wrote the delivery notes.
    tx.execute<{ source_line_id: string; quantity: string; invoiced: string }>(sql`select line_id as source_line_id, delivered::text as quantity, invoiced::text as invoiced from app.order_progress(${orderId}::uuid)`),
  ]);
  const done = new Map(delivered.map((row) => [row.source_line_id, new Decimal(row.quantity)]));
  const billed = new Map(delivered.map((row) => [row.source_line_id, new Decimal(row.invoiced)]));
  return lines.map((line) => ({
    ...line,
    unitFactor: new Decimal(line.unitFactor),
    quantity: new Decimal(line.quantity),
    unitPrice: new Decimal(line.unitPrice),
    listPrice: exact(line.listPrice),
    priceSource: line.priceSource as PriceSource | null,
    discountPercent: exact(line.discountPercent),
    delivered: done.get(line.id) ?? new Decimal(0),
    invoiced: billed.get(line.id) ?? new Decimal(0),
  }));
}

export type DeliveryProgress = { lineNo: number; itemCode: string; description: string; unitCode: string; ordered: Decimal; delivered: Decimal; remaining: Decimal; invoiced: Decimal };

/** How far a sales order has been delivered, line by line. Null when the order is not this company's or not one this member may see. */
export async function getOrderDelivery(ctx: TenantContext, orderId: string): Promise<DeliveryProgress[] | null> {
  requireDocumentAccess(ctx);
  if (!isUuid(orderId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const lines = await selectOrderLinesToDeliver(tx, ctx.tenantId, orderId);
    return lines.map((line) => ({ lineNo: line.lineNo, itemCode: line.itemCode, description: line.description, unitCode: line.unitCode, ordered: line.quantity, delivered: line.delivered, remaining: Decimal.max(line.quantity.minus(line.delivered), 0), invoiced: line.invoiced }));
  });
}

export type DeliveryRow = {
  sourceLineId: string;
  itemId: string;
  itemCode: string;
  description: string;
  unitCode: string;
  unitFactor: Decimal;
  ordered: Decimal;
  /** Delivered by other, posted notes. */
  delivered: Decimal;
  /** On this note. */
  quantity: Decimal;
  /** What the warehouse holds of the item now, in the item's own unit. */
  onHand: Decimal;
  /** What the goods cost when they left, once the note is posted; null to a reader who does not see costs. */
  cost: Decimal | null;
};

/**
 * A delivery note, or an invoice made straight from an order, against its order: every line of
 * the order that the document delivers or could still deliver, with what is ordered, already
 * gone, on this document and in stock.
 */
export async function getDeliveryRows(ctx: TenantContext, delivery: Pick<SalesDocument, "id" | "kind" | "status" | "warehouseId" | "source" | "lines">): Promise<DeliveryRow[]> {
  requireDocumentAccess(ctx);
  if (!delivery.source) return [];
  const orderId = delivery.source.id;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const order = await selectOrderLinesToDeliver(tx, ctx.tenantId, orderId);
    const [onHand, costs] = await Promise.all([
      selectStockOnHand(tx, ctx.tenantId, delivery.warehouseId, order.map((line) => line.itemId)),
      can(ctx.role, "stock.cost.read") && delivery.status !== "draft" ? selectMoveCosts(tx, ctx.tenantId, delivery.kind === "invoice" ? "sales_invoice" : "delivery_note", delivery.id) : new Map<string, Decimal>(),
    ]);
    return order
      .map((line) => {
        const mine = delivery.lines.find((own) => own.sourceLineId === line.id);
        // A posted note is itself among the posted notes: what "others" delivered leaves it out.
        const others = delivery.status === "submitted" && mine ? line.delivered.minus(mine.quantity) : line.delivered;
        return {
          sourceLineId: line.id,
          itemId: line.itemId,
          itemCode: line.itemCode,
          description: line.description,
          unitCode: line.unitCode,
          unitFactor: line.unitFactor,
          ordered: line.quantity,
          delivered: others,
          quantity: mine?.quantity ?? new Decimal(0),
          onHand: onHand.get(line.itemId) ?? new Decimal(0),
          cost: mine ? (costs.get(mine.id) ?? null) : null,
        };
      })
      .filter((row) => delivery.status === "draft" ? row.quantity.gt(0) || row.ordered.gt(row.delivered) : row.quantity.gt(0));
  });
}

/** Submitted sales orders with something still to deliver, oldest first: what the warehouse works from. */
export async function listOrdersToDeliver(ctx: TenantContext): Promise<{ id: string; number: string | null; date: string; customerName: string; lines: number }[]> {
  requireDocumentAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string | null; date: string; customer_name: string; lines: number }>(sql`
      select o.id, o.number, o.document_date::text as date, coalesce(o.buyer_name, '') as customer_name, count(*)::int as lines
      from public.sales_documents o
      join public.sales_lines l on l.tenant_id = o.tenant_id and l.document_id = o.id
      where o.tenant_id = ${ctx.tenantId} and o.kind = 'order' and o.status = 'submitted'
        and l.base_quantity > coalesce((select d.delivered_base from app.order_progress(o.id) d where d.line_id = l.id), 0)
      group by o.id, o.number, o.document_date, o.buyer_name, o.created_at
      order by o.document_date, o.created_at
      limit 200`),
  );
  return rows.map((row) => ({ id: row.id, number: row.number, date: row.date, customerName: row.customer_name, lines: row.lines }));
}

/** Whether the company charges sales tax, and whether its prices hold the tax: what every sales document is marked with. */
export async function selectTaxFlags(tx: Tx, tenantId: string): Promise<{ taxed: boolean; pricesIncludeTax: boolean }> {
  const [setup] = await tx.select({ salesTaxRegistered: companySetup.salesTaxRegistered, pricesIncludeTax: companySetup.pricesIncludeTax }).from(companySetup).where(eq(companySetup.tenantId, tenantId));
  const taxed = setup?.salesTaxRegistered ?? false;
  return { taxed, pricesIncludeTax: taxed && (setup?.pricesIncludeTax ?? false) };
}

// ── Sales invoices ──────────────────────────────────────────────────────────────────────────────

/** The invoices made from one document, drafts included, oldest first, inside a transaction the caller holds. */
export async function selectInvoicesOf(tx: Tx, tenantId: string, sourceId: string): Promise<{ id: string; number: string | null; status: SalesStatus }[]> {
  const rows = await tx
    .select({ id: salesDocuments.id, number: salesDocuments.number, status: salesDocuments.status })
    .from(salesDocuments)
    .where(and(eq(salesDocuments.tenantId, tenantId), eq(salesDocuments.kind, "invoice"), eq(salesDocuments.sourceDocumentId, sourceId)))
    .orderBy(asc(salesDocuments.createdAt));
  return rows.map((row) => ({ ...row, status: row.status as SalesStatus }));
}

/** The invoices made from a delivery note or straight from an order: what its page links to. */
export async function listInvoicesOf(ctx: TenantContext, sourceId: string): Promise<{ id: string; number: string | null; status: SalesStatus }[]> {
  if (!can(ctx.role, "sales.read") || !isUuid(sourceId)) return [];
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectInvoicesOf(tx, ctx.tenantId, sourceId));
}
