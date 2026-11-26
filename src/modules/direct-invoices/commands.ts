import "server-only";
import { audit, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { selectStockOnHand } from "@/modules/inventory/queries";
import { NeedsReason, invoiceRefusal, postInvoiceIn, saveSalesDraftIn, startInvoiceIn, submitIn, submitRefusal } from "@/modules/sales/commands";
import { selectSalesDocument } from "@/modules/sales/queries";
import { stockShortfall } from "@/modules/sales/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readDirectInvoice, type DirectInvoiceOutcome, type RawDirectInvoice } from "./rules";

// One-step "New invoice" (batch A): an invoice to a customer on the list, made in one transaction
// as a sales order, submitted (which weighs it against the customer's credit limit), then an
// invoice straight from that order, which takes the goods out of stock and puts the sale in the
// books as it posts. Each part is made by the same code that makes it from the Sales screens, so
// there is no second way of writing a document, a stock move or a journal; this only runs them
// one after another. The counter sale (src/modules/counter-sales) does the same for a walk-in buyer.
//
// What stops it part-way is kept, as the two-step way keeps it:
//   over the credit limit (not the owner): the order is left waiting for the owner's approval;
//   over the limit (the owner, with no reason given): nothing is kept, and the form asks for the reason;
//   short of stock: the order and the draft invoice are kept, and the draft's page says what is
//     short, with the quick market purchase link, and posts it once the goods are in.

export function requireInvoiceNow(ctx: TenantContext): void {
  if (!can(ctx.role, "sales.manage")) throw new UserError("Your role cannot write sales documents.");
}

function refusal(error: unknown, date: string): unknown {
  if (error instanceof UserError) return error;
  return invoiceRefusal(error, date) ?? submitRefusal(error) ?? error;
}

export async function makeInvoiceNow(ctx: TenantContext, raw: RawDirectInvoice): Promise<DirectInvoiceOutcome> {
  requireInvoiceNow(ctx);
  const read = readDirectInvoice(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const { order, reason } = read.invoice;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx): Promise<DirectInvoiceOutcome> => {
      const draft = await saveSalesDraftIn(tx, ctx, null, order);
      // Weighed against the credit limit as any order is. The owner approves it over the limit with a reason.
      const submitted = await submitIn(tx, ctx, draft.id, undefined, { reason: reason ?? undefined });
      if (submitted.status === "on_hold") {
        await audit(tx, ctx, { action: "direct_invoice.held", entity: "sales_document", entityId: draft.id, after: { message: submitted.message } });
        return { status: "on_hold", orderId: draft.id, message: submitted.message };
      }
      // Billed at once, on the order's own date: the invoice delivers the goods itself.
      const invoice = await startInvoiceIn(tx, ctx, draft.id, order.date);
      const made = await selectSalesDocument(tx, ctx.tenantId, invoice.id);
      if (!made) throw new UserError("This invoice could not be made as it stands. Reload the page and try again.");
      const onHand = await selectStockOnHand(tx, ctx.tenantId, made.warehouseId, made.lines.map((line) => line.itemId));
      const short = stockShortfall(made.lines, onHand);
      if (short) {
        const message = `Not enough ${short.itemCode} in stock at ${made.warehouseName}: ${short.onHand.toFixed()} on hand, ${short.needed.toFixed()} needed. The order ${submitted.number} is made and its invoice is waiting as a draft: bring the goods in, then post it.`;
        await audit(tx, ctx, { action: "direct_invoice.short", entity: "sales_document", entityId: invoice.id, after: { order: submitted.number, item: short.itemCode, needed: short.needed.toFixed(), onHand: short.onHand.toFixed() } });
        return { status: "short", invoiceId: invoice.id, orderNumber: submitted.number, message };
      }
      const posted = await postInvoiceIn(tx, ctx, invoice.id);
      await audit(tx, ctx, { action: "direct_invoice.post", entity: "sales_document", entityId: invoice.id, after: { order: submitted.number, invoice: posted.number, total: made.totals.total.toFixed(2) } });
      return { status: "posted", invoiceId: invoice.id, invoiceNumber: posted.number, orderNumber: submitted.number };
    });
  } catch (error) {
    if (error instanceof NeedsReason) throw error;
    throw refusal(error, order.date);
  }
}
