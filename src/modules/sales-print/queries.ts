import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { getSalesDocument, type SalesDocument } from "@/modules/sales/queries";
import { salesDocuments } from "@/modules/sales/schema";
import { getCompanySetup } from "@/modules/setup/queries";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { amountInWords, printTitle, printable, showsPrices } from "./rules";

/** The buyer as the document kept them when it was submitted. */
export type PrintedBuyer = { name: string; ntn: string | null; cnic: string | null; strn: string | null; address: string | null; province: string | null };

/** Everything a printed sales document and its PDF show. */
export type PrintableDocument = {
  document: SalesDocument & { number: string };
  title: string;
  /** False on a delivery note, and for a reader outside the sales team. */
  prices: boolean;
  seller: { name: string; ntn: string | null; strn: string | null };
  buyer: PrintedBuyer;
  /** The total in words, on documents that show prices in rupees. */
  words: string | null;
};

/**
 * One sales document, ready to print, or null when it is not this company's, not one this member
 * may see, or still has no number. The company's name is passed in from the session.
 */
export async function getPrintableDocument(ctx: TenantContext, id: string, companyName: string): Promise<PrintableDocument | null> {
  const document = await getSalesDocument(ctx, id);
  if (!document || document.number === null || !printable(document.status)) return null;
  const [setup, [snapshot]] = await Promise.all([
    getCompanySetup(ctx),
    withTenant(ctx.userId, ctx.tenantId, (tx) =>
      tx
        .select({ ntn: salesDocuments.buyerNtn, cnic: salesDocuments.buyerCnic, strn: salesDocuments.buyerStrn, address: salesDocuments.buyerAddress, province: salesDocuments.buyerProvince })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id))),
    ),
  ]);
  const prices = showsPrices(document.kind) && can(ctx.role, "sales.read");
  return {
    document: { ...document, number: document.number },
    title: printTitle(document.kind, document.taxed),
    prices,
    // Tax numbers are printed by a company registered for sales tax; its NTN is printed whenever it gave one.
    seller: { name: companyName, ntn: setup?.ntn ?? null, strn: document.taxed ? (setup?.strn ?? null) : null },
    buyer: {
      name: document.customerName,
      ntn: snapshot?.ntn ?? null,
      cnic: snapshot?.cnic ?? null,
      strn: snapshot?.strn ?? null,
      address: snapshot?.address ?? null,
      province: snapshot?.province ?? null,
    },
    words: prices ? amountInWords(document.totals.total, document.currency) : null,
  };
}
