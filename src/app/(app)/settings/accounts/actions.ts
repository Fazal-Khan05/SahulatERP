"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { addAccount, deleteAccount, seedAccounts, setAccountArchived, updateAccount } from "@/modules/ledger/commands";
import { getCompanySetup } from "@/modules/setup/queries";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command.

async function run(context: string, work: (session: Awaited<ReturnType<typeof requireTenant>>) => Promise<FormState | void>, done: FormState): Promise<FormState> {
  const session = await requireTenant();
  let result: FormState | void;
  try {
    result = await work(session);
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure(context, error);
    return { error: "That did not work. Please try again." };
  }
  if (result) return result;
  refresh();
  return done;
}

/** For a company that was set up before it had a chart of accounts: the chart it chose then. */
export async function seedAccountsAction(): Promise<FormState> {
  return run(
    "create chart of accounts",
    async (session) => {
      const setup = await getCompanySetup(session);
      if (!setup) return { error: "Finish setting up the company first: the chart of accounts is chosen there." };
      await seedAccounts(session, setup.accountsTemplate ?? "trading");
    },
    {},
  );
}

export async function addAccountAction(_: FormState, formData: FormData): Promise<FormState> {
  let code = "";
  const done = await run(
    "add account",
    async (session) => {
      code = (await addAccount(session, { parentId: formData.get("parentId"), name: formData.get("name"), code: formData.get("code"), kind: formData.get("kind") })).code;
    },
    { ok: true },
  );
  return done.ok ? { ok: true, message: `Added as ${code}.` } : done;
}

export async function updateAccountAction(id: string, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("update account", (session) => updateAccount(session, id, { name: formData.get("name"), code: formData.get("code") }, loadedAt), { message: "Saved." });
}

export async function setAccountArchivedAction(id: string, loadedAt: string, archived: boolean): Promise<FormState> {
  return run("archive account", (session) => setAccountArchived(session, id, archived, loadedAt), {});
}

export async function deleteAccountAction(id: string, loadedAt: string): Promise<FormState> {
  return run(
    "delete account",
    async (session) => {
      await deleteAccount(session, id, loadedAt);
      // The account's own page is gone; back to the chart.
      return { location: "/settings/accounts" };
    },
    {},
  );
}
