"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { addCashBankAccount, archiveCashBankAccount, cancelExpense, cancelTransfer, recordExpense, recordTransfer, saveBankDetails } from "@/modules/cash-bank/commands";

// Step 34. The company always comes from the verified session, never from the form; ids arrive
// bound to the action and are checked again in the command.

async function requireCashBankModule() {
  const session = await requireTenant();
  if (!session.modules.cash_bank) throw new UserError("Cash and bank is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

export async function addAccountAction(_: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await addCashBankAccount(session, { kind: formData.get("kind"), name: formData.get("name"), bankName: formData.get("bankName"), accountNumber: formData.get("accountNumber") });
  } catch (error) {
    return refusal("add cash or bank account", error);
  }
  refresh();
  return { ok: true, message: "Account added." };
}

export async function bankDetailsAction(accountId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await saveBankDetails(session, accountId, { bankName: formData.get("bankName"), accountNumber: formData.get("accountNumber") });
  } catch (error) {
    return refusal("save bank details", error);
  }
  refresh();
  return { message: "Saved." };
}

export async function archiveAccountAction(accountId: string, loadedAt: string): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await archiveCashBankAccount(session, accountId, loadedAt);
  } catch (error) {
    return refusal("archive cash or bank account", error);
  }
  refresh();
  return {};
}

export async function transferAction(_: FormState, formData: FormData): Promise<FormState> {
  let number: string;
  try {
    const session = await requireCashBankModule();
    ({ number } = await recordTransfer(session, {
      fromId: formData.get("fromId"),
      toId: formData.get("toId"),
      date: formData.get("date"),
      amount: formData.get("amount"),
      reference: formData.get("reference"),
      memo: formData.get("memo"),
      clientKey: formData.get("clientKey"),
    }));
  } catch (error) {
    return refusal("record transfer", error);
  }
  refresh();
  return { ok: true, message: `Recorded as ${number}.` };
}

export async function cancelTransferAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await cancelTransfer(session, id, { date: formData.get("date"), reason: formData.get("reason") });
  } catch (error) {
    return refusal("cancel transfer", error);
  }
  refresh();
  return { ok: true, message: "Cancelled." };
}

export async function expenseAction(_: FormState, formData: FormData): Promise<FormState> {
  let id: string;
  try {
    const session = await requireCashBankModule();
    const accounts = formData.getAll("lineAccountId");
    const descriptions = formData.getAll("lineDescription");
    const amounts = formData.getAll("lineAmount");
    ({ id } = await recordExpense(session, {
      date: formData.get("date"),
      accountId: formData.get("accountId"),
      supplierId: formData.get("supplierId"),
      payee: formData.get("payee"),
      branchId: formData.get("branchId"),
      reference: formData.get("reference"),
      memo: formData.get("memo"),
      incomeTaxCode: formData.get("incomeTaxCode"),
      provincialTaxCode: formData.get("provincialTaxCode"),
      lines: accounts.map((accountId, index) => ({ accountId, description: descriptions[index], amount: amounts[index] })),
      clientKey: formData.get("clientKey"),
    }));
  } catch (error) {
    return refusal("record expense", error);
  }
  return { location: `/cash-bank/expenses/${id}` };
}

export async function cancelExpenseAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await cancelExpense(session, id, { date: formData.get("date"), reason: formData.get("reason") });
  } catch (error) {
    return refusal("cancel expense", error);
  }
  refresh();
  return { ok: true, message: "Cancelled." };
}
