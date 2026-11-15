"use server";

import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { postCounterSale } from "@/modules/counter-sales/commands";
import type { SalesFormState } from "./actions";

// Step 22. The company always comes from the verified session, never from the form.

/** Records a counter sale: the order, its invoice and the payment, at once. Then opens the invoice. */
export async function counterSaleAction(_: SalesFormState, formData: FormData): Promise<SalesFormState> {
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
    const sale = await postCounterSale(session, {
      date: formData.get("date"),
      warehouseId: formData.get("warehouseId"),
      buyerName: formData.get("buyerName"),
      buyerPhone: formData.get("buyerPhone"),
      notes: formData.get("notes"),
      furtherTaxExcluded: formData.get("furtherTaxExcluded"),
      lines: itemIds.map((itemId, index) => ({ itemId, unitId: unitIds[index], quantity: quantities[index], unitPrice: unitPrices[index], discountPercent: discounts[index] })),
      shares: shareUsers.map((userId, index) => ({ userId, percent: sharePercents[index] })),
      method: formData.get("method"),
      accountId: formData.get("accountId"),
      reference: formData.get("reference"),
    });
    return { location: `/sales/${sale.invoiceId}?counter=1` };
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("record counter sale", error);
    return { error: "That did not work. Please try again." };
  }
}
