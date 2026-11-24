import "server-only";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { selectUnmatchedBank, selectUnmatchedBooks } from "./queries";
import { autoMatch, isLayout, readStatement, type ColumnNames, type Role } from "./rules";
import { readStatementFile } from "./statement-file";

// The commands behind the reconciliation screen (Step 35). Importing, matching, unmatching and
// removing an import are the database's own acts (drizzle/0041_bank_reconciliation.sql); the app
// reads the bank's file and finds what matches.

function requireReconciler(ctx: TenantContext): void {
  if (!can(ctx.role, "cash_bank.manage")) throw new UserError("A bank account is reconciled by the owner or an accountant.");
  if (ctx.branchIds !== null) throw new UserError("A bank account is reconciled by someone who works across the whole company.");
}

/** What the database refused, in words. */
function refusal(error: unknown): UserError | null {
  const code = pgCode(error);
  if (code === "SE360") return new UserError("Choose one of the company's bank accounts that is in use.");
  if (code === "SE361") return new UserError("The file's lines could not be read as a statement. Check the file and import it again.");
  if (code === "SE362") return new UserError("Every line of this file was imported before. Nothing new was added.");
  if (code === "SE363") return new UserError("Choose lines of this bank account, each once.");
  if (code === "SE364") return new UserError("One of the lines was matched meanwhile. Reload the page.");
  if (code === "SE365") return new UserError("The lines chosen do not add up to the same money. Choose lines whose total in the statement equals their total in the books.");
  if (code === "SE366") return new UserError("That statement or match is not in this company any more. Reload the page.");
  if (code === "SE367") return new UserError("Some of this statement's lines are matched. Unmatch them first.");
  if (code === "SE368") return new UserError("A statement imported after this one shares days with it. Remove that one first.");
  if (code === "23505") return new UserError("One of the entries was matched meanwhile. Reload the page.");
  if (code === "42501") return new UserError("Your role does not permit this action.");
  return null;
}

const ROLES: readonly Role[] = ["date", "description", "reference", "out", "in", "amount", "balance"];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Matches everything the rules are sure of, in a transaction already open. Returns how many. A
 * pair someone matched meanwhile is passed over (each pair has a savepoint of its own), never the
 * whole import.
 */
async function matchSure(tx: Tx, tenantId: string, accountId: string): Promise<number> {
  const pairs = autoMatch(await selectUnmatchedBank(tx, tenantId, accountId), await selectUnmatchedBooks(tx, tenantId, accountId));
  let matched = 0;
  for (const pair of pairs) {
    try {
      await tx.transaction((one) => one.execute(sql`select app.match_bank_lines(${accountId}::uuid, array[${pair.statementId}]::uuid[], array[${pair.journalLineId}]::uuid[], ${pair.rule})`));
      matched += 1;
    } catch (error) {
      if (pgCode(error) !== "SE364" && pgCode(error) !== "23505") throw error;
    }
  }
  return matched;
}

export type ImportOutcome = { problems: string[] } | { lines: number; added: number; matched: number };

/**
 * Imports a bank's statement file (CSV text, or the bytes of a CSV file or an Excel workbook) for
 * one bank account, and matches what is sure at once. A line imported before (from this file or
 * another) is not imported again. Nothing is imported when anything in the file is wrong: the
 * problems come back, each with its row.
 */
export async function importStatement(
  ctx: TenantContext,
  accountId: unknown,
  file: { name: string; text: string } | { name: string; bytes: Uint8Array },
  rawLayout: unknown,
  rawColumns: Partial<Record<Role, unknown>> = {},
): Promise<ImportOutcome> {
  requireReconciler(ctx);
  if (!isUuid(accountId)) throw new UserError("Choose one of the company's bank accounts that is in use.");
  if (!isLayout(rawLayout)) throw new UserError("Choose how the file is to be read.");
  const columns: ColumnNames = {};
  for (const role of ROLES) {
    const typed = rawColumns[role];
    if (typeof typed === "string" && typed.trim() !== "") columns[role] = typed.trim().slice(0, 60);
  }
  const read = "bytes" in file ? await readStatementFile(file.bytes, rawLayout, columns) : readStatement(file.text, rawLayout, columns);
  if (!read.ok) return { problems: read.problems };
  const lines = read.lines.map((line) => ({
    date: line.date,
    description: line.description,
    reference: line.reference,
    amount: line.amount.toFixed(AMOUNT_SCALE),
    balance: line.balance?.toFixed(AMOUNT_SCALE) ?? null,
    fingerprint: line.fingerprint,
  }));
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ result: { lines: number; added: number } }>(sql`
        select app.import_bank_statement(${accountId}::uuid, ${file.name.trim().slice(0, 200) || "statement.csv"}, ${rawLayout}, ${JSON.stringify(lines)}::jsonb,
          ${read.opening?.toFixed(AMOUNT_SCALE) ?? null}::numeric, ${read.closing?.toFixed(AMOUNT_SCALE) ?? null}::numeric) as result`);
      const matched = await matchSure(tx, ctx.tenantId, accountId);
      return { lines: row.result.lines, added: row.result.added, matched };
    } catch (error) {
      throw refusal(error) ?? error;
    }
  });
}

/** Matches everything the rules are sure of on one bank account. Returns how many were matched. */
export async function matchAutomatically(ctx: TenantContext, accountId: unknown): Promise<{ matched: number }> {
  requireReconciler(ctx);
  if (!isUuid(accountId)) throw new UserError("Choose one of the company's bank accounts that is in use.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      return { matched: await matchSure(tx, ctx.tenantId, accountId) };
    } catch (error) {
      throw refusal(error) ?? error;
    }
  });
}

/** Matches statement lines with entries in the books by hand: they must add up to the same money. */
export async function matchByHand(ctx: TenantContext, accountId: unknown, statementLineIds: unknown[], journalLineIds: unknown[]): Promise<{ id: string }> {
  requireReconciler(ctx);
  if (!isUuid(accountId)) throw new UserError("Choose one of the company's bank accounts that is in use.");
  if (![...statementLineIds, ...journalLineIds].every(isUuid)) throw new UserError("Choose lines of this bank account, each once.");
  if (statementLineIds.length + journalLineIds.length === 0) throw new UserError("Choose the lines to match: from the statement, from the books, or both.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx.execute<{ id: string }>(sql`
        select app.match_bank_lines(${accountId}::uuid, ${`{${statementLineIds.join(",")}}`}::uuid[], ${`{${journalLineIds.join(",")}}`}::uuid[], 'by_hand') as id`);
      return { id: row.id };
    } catch (error) {
      throw refusal(error) ?? error;
    }
  });
}

/** Takes a match back: its lines are unmatched again. */
export async function unmatch(ctx: TenantContext, matchId: unknown): Promise<void> {
  requireReconciler(ctx);
  if (!isUuid(matchId)) throw new UserError("That match is not in this company any more. Reload the page.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      await tx.execute(sql`select app.unmatch_bank(${matchId}::uuid)`);
    } catch (error) {
      throw refusal(error) ?? error;
    }
  });
}

/** Removes a statement imported by mistake, while none of its lines is matched. */
export async function deleteStatement(ctx: TenantContext, statementId: unknown): Promise<void> {
  requireReconciler(ctx);
  if (!isUuid(statementId)) throw new UserError("That statement is not in this company any more. Reload the page.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      await tx.execute(sql`select app.delete_bank_statement(${statementId}::uuid)`);
    } catch (error) {
      throw refusal(error) ?? error;
    }
  });
}
