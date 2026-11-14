"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { approveCommission, payCommission } from "@/modules/commission-ledger/commands";

// Approving and paying commission. The company always comes from the verified session, never
// from the form. Ids arrive bound to the action or in the form and are checked in the command.

async function requireCommissions() {
  const session = await requireTenant();
  if (!session.modules.commissions) throw new UserError("Commissions is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** Approves the commissions ticked on the page. */
export async function approveCommissionAction(_: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCommissions();
    const { approved } = await approveCommission(session, formData.getAll("accrualId"));
    refresh();
    return { message: approved === 1 ? "Commission approved for payment." : `${approved} commissions approved for payment.` };
  } catch (error) {
    return refusal("approve commission", error);
  }
}

/** Pays one person everything of theirs that is approved. */
export async function payCommissionAction(userId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCommissions();
    const paid = await payCommission(session, userId, { date: formData.get("date"), accountId: formData.get("accountId"), note: formData.get("note") });
    refresh();
    return {
      message: paid.recovered.isZero()
        ? `${paid.number}: ${paid.amount.toFixed(2)} paid.`
        : `${paid.number}: ${paid.gross.toFixed(2)} approved, ${paid.recovered.toFixed(2)} of what was owed back taken out of it, ${paid.amount.toFixed(2)} paid.`,
    };
  } catch (error) {
    return refusal("pay commission", error);
  }
}
