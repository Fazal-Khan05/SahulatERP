"use server";

import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { makeInvoiceNow } from "@/modules/direct-invoices/commands";
import { nextPage } from "@/modules/direct-invoices/rules";
import { NeedsReason } from "@/modules/sales/commands";
import type { SalesFormState } from "./actions";

// One-step "New invoice" (batch A). The company always comes from the verified session, never from the form.

/** Makes the order, its delivery and its invoice at once, then opens what came of it. */
export async function invoiceNowAction(_: SalesFormState, formData: FormData): Promise<SalesFormState> {
  try {
    const session = await requireTenant();
    if (!session.modules.sales) throw new UserError("Sales is switched off for this company.");
    const itemIds = formData.getAll("itemId");
    const unitIds = formData.getAll("unitId");
    const quantities = formData.getAll("quantity");
    const unitPrices = formData.getAll("unitPrice");
    const discounts = formData.getAll("discountPercent");
    const shareUsers = formData.getAll("shareUserId");
    const sharePercents = formData.getAll("sharePercent");
    const outcome = await makeInvoiceNow(session, {
      date: formData.get("date"),
      customerId: formData.get("customerId"),
      warehouseId: formData.get("warehouseId"),
      customerReference: formData.get("customerReference"),
      notes: formData.get("notes"),
      furtherTaxExcluded: formData.get("furtherTaxExcluded"),
      lines: itemIds.map((itemId, index) => ({ itemId, unitId: unitIds[index], quantity: quantities[index], unitPrice: unitPrices[index], discountPercent: discounts[index] })),
      shares: shareUsers.map((userId, index) => ({ userId, percent: sharePercents[index] })),
      reason: formData.get("reason"),
    });
    return { location: nextPage(outcome) };
  } catch (error) {
    if (error instanceof NeedsReason) return { error: error.message, needsReason: true };
    if (error instanceof UserError) return { error: error.message };
    logFailure("make invoice now", error);
    return { error: "That did not work. Please try again." };
  }
}
