import "server-only";
import { sql } from "drizzle-orm";
import { isUuid, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { MAX_JOURNAL_MEMO, checkJournalLines, isJournalSource, type JournalLineInput, type JournalSourceType } from "./rules";

// The posting engine. Every journal in the books is written here, by one call inside the
// transaction of the command that needs it, so a document, its stock moves and its journal are
// kept or dropped together. The rows themselves are written by the database function
// app.post_journal: the app has no INSERT, UPDATE or DELETE on the ledger tables.

/** The document a journal is posted for. One document posts at most one journal. */
export type JournalSource = {
  type: JournalSourceType;
  id: string;
  /** The date the journal carries; it must fall in a fiscal period that is open and not locked. */
  date: string;
  /** The document's own number, such as JV-2627-00001, shown when the ledger is read. A number names one journal. */
  documentNumber?: string | null;
  memo?: string | null;
  /** Null for a journal that belongs to the whole company. */
  branchId?: string | null;
};

const MESSAGES: Record<string, string> = {
  SE003: "The journal does not balance.",
  SE005: "cannot be used in this kind of entry. It is kept by its own documents, so that it always agrees with them.",
  SE006: "That journal is not in this company.",
  SE007: "A reversal cannot be reversed. Post the journal again instead.",
  SE008: "That journal has already been reversed.",
  SE009: "A reversal is dated on or after the journal it reverses.",
  SE011: "is a heading. Amounts go to the accounts under it.",
  SE012: "is archived. Restore it, or choose another account.",
  SE013: "A line on a customers' account must name the customer.",
  SE014: "A line on a suppliers' account must name the supplier.",
  SE015: "That date is before the day the books were opened here. What happened before then is already part of the opening balances.",
  SE020: "A posted journal is never changed. Post a reversal instead.",
  "23503": "An account, customer, supplier or branch on the journal is not in this company.",
  "23505": "This has already been posted.",
  "23514": "The journal was refused: one of its lines is not a valid debit or credit.",
  "42501": "You are not allowed to post this: your role or your branches do not include it.",
};

/** The message for a refusal by the database, or null when the failure is not a refusal. */
function refusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error) ?? "";
  const period = periodRefusal(code, date);
  if (period) return new UserError(period);
  const message = MESSAGES[code];
  if (!message) return null;
  if (code === "SE005" || code === "SE011" || code === "SE012") {
    // The database names the account by its code, which can only hold digits, capitals, dots and dashes.
    const text = (error as { cause?: { message?: unknown }; message?: unknown })?.cause?.message ?? (error as { message?: unknown })?.message;
    const account = typeof text === "string" ? /account ([0-9A-Z.-]{1,12}) /.exec(text)?.[1] : undefined;
    return new UserError(`${account ? `Account ${account}` : "One of the accounts"} ${message}`);
  }
  return new UserError(message);
}

const optionalId = (value: string | null | undefined, what: string): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (!isUuid(value)) throw new UserError(`The ${what} on the journal is not in this company.`);
  return value;
};

/**
 * Posts one journal for a source document, inside the caller's transaction, and returns the
 * journal's id. The lines must balance; the date must fall in an open fiscal period; the source
 * must not have posted before. A refusal is a UserError and leaves the transaction failed, so
 * the caller's document is not kept either.
 */
export async function postJournal(tx: Tx, source: JournalSource, lines: readonly JournalLineInput[]): Promise<string> {
  if (!isJournalSource(source.type) || !isUuid(source.id)) throw new UserError("A journal needs the document it is posted for.");
  if (!isIsoDate(source.date)) throw new UserError("A journal needs a date.");
  const checked = checkJournalLines(lines);
  if (!checked.ok) throw new UserError(checked.reason);
  const posted = lines.map((line) => {
    if (!isUuid(line.accountId)) throw new UserError("An account on the journal is not in this company.");
    return {
      account_id: line.accountId,
      debit: (line.debit ?? null)?.toFixed(AMOUNT_SCALE) ?? "0",
      credit: (line.credit ?? null)?.toFixed(AMOUNT_SCALE) ?? "0",
      description: line.description ?? null,
      customer_id: optionalId(line.customerId, "customer"),
      supplier_id: optionalId(line.supplierId, "supplier"),
    };
  });
  const memo = (source.memo ?? "").trim();
  if (memo.length > MAX_JOURNAL_MEMO) throw new UserError(`What the journal is for: use at most ${MAX_JOURNAL_MEMO} characters.`);
  const documentNumber = (source.documentNumber ?? "").trim();
  if (documentNumber.length > 40) throw new UserError("That document number is too long.");
  const branchId = optionalId(source.branchId, "branch");
  try {
    const rows = await tx.execute<{ id: string }>(
      sql`select app.post_journal(${source.date}::date, ${source.type}, ${source.id}::uuid, ${JSON.stringify(posted)}::jsonb, ${memo === "" ? null : memo}, ${branchId}::uuid, ${documentNumber === "" ? null : documentNumber}) as id`,
    );
    return rows[0].id;
  } catch (error) {
    throw refusal(error, source.date) ?? error;
  }
}

/**
 * Reverses a posted journal inside the caller's transaction: a new journal on `date` with every
 * debit and credit swapped. Returns the reversal's id. A journal is reversed at most once.
 */
export async function reverseJournal(tx: Tx, journalId: string, reversal: { date: string; memo?: string | null }): Promise<string> {
  if (!isUuid(journalId)) throw new UserError("That journal is not in this company.");
  if (!isIsoDate(reversal.date)) throw new UserError("A reversal needs a date.");
  const memo = (reversal.memo ?? "").trim().slice(0, MAX_JOURNAL_MEMO);
  try {
    const rows = await tx.execute<{ id: string }>(sql`select app.reverse_journal(${journalId}::uuid, ${reversal.date}::date, ${memo === "" ? null : memo}) as id`);
    return rows[0].id;
  } catch (error) {
    if (pgCode(error) === "42501") throw new UserError("Your role cannot reverse this.");
    throw refusal(error, reversal.date) ?? error;
  }
}
