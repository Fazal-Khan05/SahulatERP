import "server-only";
import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { parseCsv } from "@/lib/csv";
import { todayIso } from "@/lib/format";
import type { ObjectStore } from "@/lib/storage";
import { readSheet } from "@/modules/bank-reconciliation/statement-file";
import { recordExpenseIn, refusal, requireManager } from "@/modules/cash-bank/commands";
import { checkFile, fileNameSchema, storageKey } from "@/modules/files/rules";
import { files } from "@/modules/files/schema";
import { firstIssue, type TenantContext } from "@/modules/tenant/rules";
import { getDailyChoices } from "./queries";
import { checkSheet, readDailyExpense, readSheetCells, toExpense, type RawDailyExpense, type SheetCells, type SheetRow } from "./rules";

// The commands behind the daily expenses screens. An entry is recorded by the cash and bank
// module's own function inside the database (recordExpenseIn): there is no second way of writing
// an expense, its journal or its number. A receipt is a stored file (src/modules/files) tied to
// its expense by app.attach_expense_receipt (drizzle/0046_daily_expenses.sql).

const NOT_AN_ACCOUNT = "Choose the accounts again: one of them is not in this company.";

/** The name of the expense account an entry is charged to, or a refusal: an entry is charged to an expense account in use. */
async function whatForNames(ctx: TenantContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.some((id) => !isUuid(id))) throw new UserError(NOT_AN_ACCOUNT);
  const choices = await getDailyChoices(ctx);
  const names = new Map(choices.expenseAccounts.map((a) => [a.id, a.name]));
  if (ids.some((id) => !names.has(id))) throw new UserError("Choose what it was for from the company's expense accounts in use.");
  return names;
}

/** Records one daily expense. Sent twice with the same key it is recorded once. Returns its id and number. */
export async function recordDailyExpense(ctx: TenantContext, raw: RawDailyExpense & { clientKey?: unknown }): Promise<{ id: string; number: string }> {
  requireManager(ctx);
  const read = readDailyExpense(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const entry = read.expense;
  const names = await whatForNames(ctx, [entry.whatForId]);
  const key = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  try {
    return await withTenant(ctx.userId, ctx.tenantId, (tx) => recordExpenseIn(tx, toExpense(entry, names.get(entry.whatForId)!), key));
  } catch (error) {
    if (pgCode(error) === "22P02") throw new UserError(NOT_AN_ACCOUNT);
    throw refusal(error, entry.date) ?? error;
  }
}

// ── Receipts ────────────────────────────────────────────────────────────────────────────────────

/** A receipt that could be kept, read from its bytes; or why not, in words. Checked before anything is recorded. */
export function readReceipt(input: { name: unknown; bytes: Uint8Array }): { name: string; contentType: string; bytes: Uint8Array } {
  const name = fileNameSchema.safeParse(input.name);
  if (!name.success) throw new UserError(firstIssue(name.error));
  const checked = checkFile(input.bytes);
  if (!checked.ok) throw new UserError(checked.reason === "Use a PDF, PNG, JPEG or WebP file." ? "A receipt is a PDF, or a photo as PNG, JPEG or WebP." : checked.reason);
  return { name: name.data, contentType: checked.contentType, bytes: input.bytes };
}

/**
 * Keeps a PDF or a photo as the receipt of an expense. The object store is an outside system, so
 * the intent is recorded first (a "pending" file row), the bytes are sent, and the outcome is
 * recorded after: the row becomes "stored" and is tied to the expense in one transaction, with
 * its audit row. If the send fails the row stays pending and nothing claims a receipt exists.
 */
export async function attachReceipt(ctx: TenantContext, store: ObjectStore, expenseId: unknown, input: { name: unknown; bytes: Uint8Array }): Promise<{ id: string }> {
  requireManager(ctx);
  if (!isUuid(expenseId)) throw new UserError("That expense is not in this company.");
  const receipt = readReceipt(input);
  const fileId = randomUUID();
  const key = storageKey(ctx.tenantId, fileId);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      // Under row-level security: an expense of another company, or of a branch this person does not work in, is not found.
      const [expense] = await tx.execute<{ receipts: number }>(sql`
        select (select count(*)::int from public.expense_receipts r where r.tenant_id = e.tenant_id and r.expense_id = e.id) as receipts
        from public.expenses e where e.tenant_id = ${ctx.tenantId} and e.id = ${expenseId}`);
      if (!expense) throw new UserError("That expense is not in this company.");
      if (expense.receipts >= 10) throw new UserError("An expense has at most ten receipts.");
      await tx.insert(files).values({ id: fileId, tenantId: ctx.tenantId, storageKey: key, name: receipt.name, contentType: receipt.contentType, sizeBytes: receipt.bytes.length, createdBy: ctx.userId });
    });
    await store.put(key, receipt.bytes, receipt.contentType);
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const marked = await tx
        .update(files)
        .set({ status: "stored", storedAt: sql`now()` })
        .where(and(eq(files.tenantId, ctx.tenantId), eq(files.id, fileId)))
        .returning({ id: files.id });
      // Nothing marked means this person's role changed between the two steps.
      if (marked.length === 0) throw new UserError("The receipt could not be kept. Try again.");
      const [row] = await tx.execute<{ id: string }>(sql`select app.attach_expense_receipt(${expenseId}::uuid, ${fileId}::uuid) as id`);
      return { id: row.id };
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    const code = pgCode(error);
    if (code === "SE334") throw new UserError("That expense is not in this company.");
    if (code === "SE376") throw new UserError("The receipt could not be kept. Try again.");
    if (code === "SE377") throw new UserError("An expense has at most ten receipts.");
    if (code === "42501") throw new UserError("Only the owner or an accountant keeps the receipts of expenses.");
    throw error;
  }
}

// ── A sheet of expenses ─────────────────────────────────────────────────────────────────────────

/** The largest sheet read: far more than two hundred rows need. */
export const MAX_SHEET_BYTES = 1024 * 1024;

const isWorkbook = (bytes: Uint8Array) => (bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf);

/** The branch a sheet's expenses belong to: one of this person's, when they are limited to some; otherwise one of the company's, or the whole company. */
function sheetBranch(ctx: TenantContext, branchId: unknown, branches: readonly { id: string }[]): string | null {
  const wanted = typeof branchId === "string" ? branchId.trim() : "";
  if (wanted === "") {
    if (ctx.branchIds !== null) throw new UserError("Choose one of your branches.");
    return null;
  }
  if (!branches.some((b) => b.id === wanted) || (ctx.branchIds !== null && !ctx.branchIds.includes(wanted))) throw new UserError("Choose one of your branches.");
  return wanted;
}

/**
 * A sheet as it arrives, an Excel workbook (.xlsx) by what it is or anything else as CSV text,
 * read into its typed rows. The file comes from outside: only someone who may enter expenses has
 * one opened at all.
 */
export async function readExpenseSheetFile(ctx: TenantContext, bytes: Uint8Array): Promise<{ ok: true; cells: SheetCells[] } | { ok: false; reason: string }> {
  requireManager(ctx);
  if (bytes.length === 0) return { ok: false, reason: "Choose the sheet: an Excel file (.xlsx) or a CSV file." };
  if (bytes.length > MAX_SHEET_BYTES) return { ok: false, reason: "The file is too large for a sheet of expenses. Enter at most 200 at a time." };
  if (isWorkbook(bytes)) {
    const sheet = await readSheet(bytes);
    return sheet.ok ? readSheetCells(sheet.rows) : sheet;
  }
  const csv = parseCsv(new TextDecoder().decode(bytes));
  return csv.ok ? readSheetCells(csv.rows) : csv;
}

/** A sheet's rows checked against the company's accounts as they are now: what each would enter, or what is wrong with it. Nothing is recorded. */
export async function previewExpenseSheet(ctx: TenantContext, cells: readonly SheetCells[], branchId: unknown): Promise<SheetRow[]> {
  requireManager(ctx);
  const choices = await getDailyChoices(ctx);
  return checkSheet(cells, { expense: choices.expenseAccounts, money: choices.moneyAccounts }, todayIso(new Date()), sheetBranch(ctx, branchId, choices.branches));
}

/** The id of the expense a row of a sheet makes: the same for the same sheet sent twice, so each row is recorded once. */
function rowKey(batch: string, row: number): string {
  const hex = createHash("sha256").update(`daily-expenses:${batch}:${row}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Enters a sheet of expenses: every row recorded, in one transaction, or none. The rows are
 * checked again here against the company's accounts as they are now, whatever the preview said.
 * Sent twice with the same key, each row is recorded once.
 */
export async function recordExpenseSheet(ctx: TenantContext, input: { cells: readonly SheetCells[]; branchId: unknown; clientKey: unknown }): Promise<{ count: number; first: string; last: string; total: string }> {
  requireManager(ctx);
  if (!isUuid(input.clientKey)) throw new UserError("Upload the sheet again.");
  const batch = input.clientKey;
  const rows = await previewExpenseSheet(ctx, input.cells, input.branchId);
  if (rows.length === 0) throw new UserError("The sheet has no expenses in it.");
  const bad = rows.filter((row) => row.problems.length > 0);
  if (bad.length > 0) throw new UserError(`Nothing was entered. Row ${bad[0].row}: ${bad[0].problems[0]}`);
  const names = await whatForNames(ctx, rows.map((row) => row.expense!.whatForId));
  let at = rows[0];
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const numbers: string[] = [];
      let total = new Decimal(0);
      for (const row of rows) {
        at = row;
        const entry = row.expense!;
        const { number } = await recordExpenseIn(tx, toExpense(entry, names.get(entry.whatForId)!), rowKey(batch, row.row));
        numbers.push(number);
        total = total.plus(entry.amount);
      }
      return { count: numbers.length, first: numbers[0], last: numbers.at(-1)!, total: total.toFixed(2) };
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    const known = pgCode(error) === "22P02" ? new UserError(NOT_AN_ACCOUNT) : refusal(error, at.expense!.date);
    if (known instanceof UserError) throw new UserError(`Nothing was entered. Row ${at.row}: ${known.message}`);
    throw error;
  }
}
