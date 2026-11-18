"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { issueLoan, repayLoan, saveBankAccount } from "@/modules/staff-loans/commands";

// Step 42. The company always comes from the verified session, never from the form; ids arrive
// bound to the action and are checked again in the command and by the database.

async function requirePayrollModule() {
  const session = await requireTenant();
  if (!session.modules.payroll) throw new UserError("Payroll is switched off for this company. An owner switches it on under Settings, Modules.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

export async function bankAccountAction(employeeId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    await saveBankAccount(await requirePayrollModule(), employeeId, { bankName: formData.get("bankName"), accountTitle: formData.get("accountTitle"), iban: formData.get("iban") });
  } catch (error) {
    return refusal("save bank account", error);
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function issueLoanAction(_: FormState, formData: FormData): Promise<FormState> {
  let number: string;
  try {
    ({ number } = await issueLoan(await requirePayrollModule(), {
      employeeId: formData.get("employeeId"),
      date: formData.get("date"),
      amount: formData.get("amount"),
      instalment: formData.get("instalment"),
      accountId: formData.get("accountId"),
      note: formData.get("note"),
    }));
  } catch (error) {
    return refusal("issue staff loan", error);
  }
  refresh();
  return { ok: true, message: `Paid as ${number}.` };
}

export async function repayLoanAction(loanId: string, _: FormState, formData: FormData): Promise<FormState> {
  let number: string;
  try {
    ({ number } = await repayLoan(await requirePayrollModule(), loanId, { date: formData.get("date"), amount: formData.get("amount"), accountId: formData.get("accountId") }));
  } catch (error) {
    return refusal("repay staff loan", error);
  }
  refresh();
  return { ok: true, message: `Repaid as ${number}.` };
}
