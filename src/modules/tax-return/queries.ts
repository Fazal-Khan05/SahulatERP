import "server-only";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { audit, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { PROVINCES, type Province } from "@/modules/parties/rules";
import { companySetup } from "@/modules/setup/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { AnnexARow, AnnexBRow, AnnexC1Row, AnnexCRow, AnnexH1Row, LedgerRow, ReturnPeriod, TaxReturn } from "./rules";
import { taxReturnSettings } from "./schema";

// The sales tax return's read model. Every figure comes from the functions in
// drizzle/0038_sales_tax_return.sql, which read what posting stored and ask who is reading; the
// checks here only give a clear refusal before a query is tried.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");
const dn = (value: string | null | undefined) => (value === null || value === undefined ? null : new Decimal(value));

export const WHOLE_COMPANY_ONLY = "The sales tax return covers the whole company, so it is not shown to a member limited to some branches.";

export function requireTaxReturn(ctx: TenantContext): void {
  if (!can(ctx.role, "tax_return.read")) throw new UserError("Only an owner, an accountant or an auditor can see the sales tax return.");
  if (ctx.branchIds !== null) throw new UserError(WHOLE_COMPANY_ONLY);
}

export type ReturnStanding = { registered: boolean; strn: string | null; ntn: string | null; province: Province | null };

/** Whether the company is registered for sales tax, its numbers, and the province it supplies from. */
export async function getReturnStanding(ctx: TenantContext): Promise<ReturnStanding> {
  requireTaxReturn(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [[setup], [settings]] = await Promise.all([
      tx.select({ registered: companySetup.salesTaxRegistered, strn: companySetup.strn, ntn: companySetup.ntn }).from(companySetup).where(eq(companySetup.tenantId, ctx.tenantId)),
      tx.select({ province: taxReturnSettings.province }).from(taxReturnSettings).where(eq(taxReturnSettings.tenantId, ctx.tenantId)),
    ]);
    return { registered: setup?.registered ?? false, strn: setup?.strn ?? null, ntn: setup?.ntn ?? null, province: settings?.province ?? null };
  });
}

type CRow = {
  doc_kind: "invoice" | "credit_note"; document_number: string; document_date: string;
  buyer_name: string | null; buyer_ntn: string | null; buyer_cnic: string | null; buyer_strn: string | null; buyer_registration_type: string | null; buyer_province: string | null;
  original_number: string | null; original_date: string | null;
  line_no: number; hs_code: string | null; description: string; sale_type: string | null; tax_kind: string; tax_rate: string;
  quantity: string; uom: string | null; value: string; retail_value: string | null;
  sales_tax: string; extra_tax: string; further_tax: string; sro_schedule_no: string | null; sro_item_serial: string | null; total: string;
};
type C1Row = {
  receipt_number: string; receipt_date: string; method: "cash" | "bank" | "cheque"; cheque_number: string | null; cheque_bank: string | null; reference: string | null;
  buyer_name: string | null; buyer_ntn: string | null; buyer_cnic: string | null; buyer_strn: string | null; buyer_registration_type: string | null;
  invoice_number: string; invoice_date: string; invoice_total: string; invoice_tax: string; amount: string; allocated_on: string;
};
type ARow = {
  doc_kind: "bill" | "debit_note"; document_number: string; supplier_invoice_no: string | null; document_date: string;
  supplier_name: string; supplier_ntn: string | null; supplier_cnic: string | null; supplier_strn: string | null; supplier_registration_type: string | null; supplier_province: string | null;
  original_number: string | null; original_date: string | null;
  line_no: number; line_kind: "goods" | "expense"; hs_code: string | null; description: string | null; tax_rate: string | null;
  quantity: string | null; uom: string | null; value: string; sales_tax: string; st_withheld: string; total: string;
};
type BRow = {
  shipment_number: string; gd_number: string | null; gd_date: string | null; port: string | null; origin: string | null; supplier_name: string;
  hs_codes: string | null; customs_value: string | null; sales_tax: string; income_tax: string; allocated_on: string; first_spreading: boolean;
};
type H1Row = {
  item_code: string | null; item_name: string; hs_code: string | null; uom: string | null; tax_rate: string | null;
  opening_quantity: string; opening_value: string; imported_quantity: string; imported_value: string; purchased_quantity: string; purchased_value: string;
  supplied_quantity: string; supplied_value: string; other_quantity: string; other_value: string; closing_quantity: string; closing_value: string;
};
type LRow = { control: LedgerRow["control"]; source_type: string; debit: string; credit: string };

/** The month's return: the five annexes and what the ledger says, all read in one transaction. */
export async function getTaxReturn(ctx: TenantContext, period: ReturnPeriod): Promise<TaxReturn> {
  requireTaxReturn(ctx);
  const from = sql`${period.from}::date`;
  const to = sql`${period.to}::date`;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [settings] = await tx.select({ province: taxReturnSettings.province }).from(taxReturnSettings).where(eq(taxReturnSettings.tenantId, ctx.tenantId));
    const c = await tx.execute<CRow>(sql`
      select doc_kind, document_number, document_date::text, buyer_name, buyer_ntn, buyer_cnic, buyer_strn, buyer_registration_type, buyer_province,
        original_number, original_date::text, line_no, hs_code, description, sale_type, tax_kind, tax_rate::text, quantity::text, uom, value::text,
        retail_value::text, sales_tax::text, extra_tax::text, further_tax::text, sro_schedule_no, sro_item_serial, total::text
      from app.annex_c_rows(${from}, ${to})`);
    const c1 = await tx.execute<C1Row>(sql`
      select receipt_number, receipt_date::text, method, cheque_number, cheque_bank, reference, buyer_name, buyer_ntn, buyer_cnic, buyer_strn,
        buyer_registration_type, invoice_number, invoice_date::text, invoice_total::text, invoice_tax::text, amount::text, allocated_on::text
      from app.annex_c1_rows(${from}, ${to})`);
    const a = await tx.execute<ARow>(sql`
      select doc_kind, document_number, supplier_invoice_no, document_date::text, supplier_name, supplier_ntn, supplier_cnic, supplier_strn,
        supplier_registration_type, supplier_province, original_number, original_date::text, line_no, line_kind, hs_code, description,
        tax_rate::text, quantity::text, uom, value::text, sales_tax::text, st_withheld::text, total::text
      from app.annex_a_rows(${from}, ${to})`);
    const b = await tx.execute<BRow>(sql`
      select shipment_number, gd_number, gd_date::text, port, origin, supplier_name, hs_codes, customs_value::text, sales_tax::text, income_tax::text,
        allocated_on::text, first_spreading
      from app.annex_b_rows(${from}, ${to})`);
    const h1 = await tx.execute<H1Row>(sql`
      select item_code, item_name, hs_code, uom, tax_rate::text, opening_quantity::text, opening_value::text, imported_quantity::text, imported_value::text,
        purchased_quantity::text, purchased_value::text, supplied_quantity::text, supplied_value::text, other_quantity::text, other_value::text,
        closing_quantity::text, closing_value::text
      from app.annex_h1_rows(${from}, ${to})`);
    const ledger = await tx.execute<LRow>(sql`select control, source_type, debit::text, credit::text from app.tax_return_ledger(${from}, ${to})`);

    return {
      period,
      province: settings?.province ?? null,
      c: c.map((r): AnnexCRow => ({
        docKind: r.doc_kind, number: r.document_number, date: r.document_date,
        buyerName: r.buyer_name, buyerNtn: r.buyer_ntn, buyerCnic: r.buyer_cnic, buyerStrn: r.buyer_strn, buyerRegistered: r.buyer_registration_type === "registered", buyerProvince: r.buyer_province,
        originalNumber: r.original_number, originalDate: r.original_date,
        lineNo: r.line_no, hsCode: r.hs_code, description: r.description, saleType: r.sale_type, taxKind: r.tax_kind, taxRate: d(r.tax_rate),
        quantity: d(r.quantity), uom: r.uom, value: d(r.value), retailValue: dn(r.retail_value),
        salesTax: d(r.sales_tax), extraTax: d(r.extra_tax), furtherTax: d(r.further_tax), sroScheduleNo: r.sro_schedule_no, sroItemSerial: r.sro_item_serial, total: d(r.total),
      })),
      c1: c1.map((r): AnnexC1Row => ({
        receiptNumber: r.receipt_number, receiptDate: r.receipt_date, method: r.method, chequeNumber: r.cheque_number, chequeBank: r.cheque_bank, reference: r.reference,
        buyerName: r.buyer_name, buyerNtn: r.buyer_ntn, buyerCnic: r.buyer_cnic, buyerStrn: r.buyer_strn, buyerRegistered: r.buyer_registration_type === "registered",
        invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, invoiceTotal: d(r.invoice_total), invoiceTax: d(r.invoice_tax), amount: d(r.amount), allocatedOn: r.allocated_on,
      })),
      a: a.map((r): AnnexARow => ({
        docKind: r.doc_kind, number: r.document_number, supplierInvoiceNo: r.supplier_invoice_no, date: r.document_date,
        supplierName: r.supplier_name, supplierNtn: r.supplier_ntn, supplierCnic: r.supplier_cnic, supplierStrn: r.supplier_strn, supplierRegistered: r.supplier_registration_type === "registered", supplierProvince: r.supplier_province,
        originalNumber: r.original_number, originalDate: r.original_date,
        lineNo: r.line_no, lineKind: r.line_kind, hsCode: r.hs_code, description: r.description, taxRate: dn(r.tax_rate),
        quantity: dn(r.quantity), uom: r.uom, value: d(r.value), salesTax: d(r.sales_tax), stWithheld: d(r.st_withheld), total: d(r.total),
      })),
      b: b.map((r): AnnexBRow => ({
        shipmentNumber: r.shipment_number, gdNumber: r.gd_number, gdDate: r.gd_date, port: r.port, origin: r.origin, supplierName: r.supplier_name,
        hsCodes: r.hs_codes, customsValue: dn(r.customs_value), salesTax: d(r.sales_tax), incomeTax: d(r.income_tax), allocatedOn: r.allocated_on, firstSpreading: r.first_spreading,
      })),
      h1: h1.map((r): AnnexH1Row => ({
        itemCode: r.item_code, itemName: r.item_name, hsCode: r.hs_code, uom: r.uom, taxRate: dn(r.tax_rate),
        openingQuantity: d(r.opening_quantity), openingValue: d(r.opening_value), importedQuantity: d(r.imported_quantity), importedValue: d(r.imported_value),
        purchasedQuantity: d(r.purchased_quantity), purchasedValue: d(r.purchased_value), suppliedQuantity: d(r.supplied_quantity), suppliedValue: d(r.supplied_value),
        otherQuantity: d(r.other_quantity), otherValue: d(r.other_value), closingQuantity: d(r.closing_quantity), closingValue: d(r.closing_value),
      })),
      ledger: ledger.map((r): LedgerRow => ({ control: r.control, sourceType: r.source_type, debit: d(r.debit), credit: d(r.credit) })),
    };
  });
}

/** Sets the province the company supplies from. Written by the owner or an accountant. */
export async function setReturnProvince(ctx: TenantContext, province: unknown): Promise<void> {
  if (!can(ctx.role, "tax_return.settings")) throw new UserError("Only an owner or an accountant can set the province.");
  if (typeof province !== "string" || !(PROVINCES as readonly string[]).includes(province)) throw new UserError("Choose a province.");
  const chosen = province as Province;
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [before] = await tx.select({ province: taxReturnSettings.province }).from(taxReturnSettings).where(eq(taxReturnSettings.tenantId, ctx.tenantId));
    if (before?.province === chosen) return;
    if (before) {
      await tx.update(taxReturnSettings).set({ province: chosen, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(eq(taxReturnSettings.tenantId, ctx.tenantId));
    } else {
      await tx.execute(sql`insert into public.tax_return_settings (tenant_id, province, created_by, updated_by) values (${ctx.tenantId}, ${chosen}, ${ctx.userId}, ${ctx.userId})`);
    }
    await audit(tx, ctx, { action: "tax_return.province", entity: "tax_return_settings", entityId: ctx.tenantId, before: before ?? null, after: { province: chosen } });
  });
}
