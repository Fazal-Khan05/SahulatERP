import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { formatAmount } from "@/lib/money";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { buildCommissionStatement, figuresByPerson, figuresOf, type CommissionStatement, type MovementType, type PersonFigures } from "./rules";

// Read models for commission statements (Step 39). The database decides whose statement a
// member may read (app.commission_statement_people, drizzle/0028_commission_statements.sql):
// the owner, an accountant and the auditor everyone's, anyone else their own and their team's.

/** Whoever can earn or oversee commission may open the statements; the database narrows it to whose. */
export const canReadStatements = (ctx: Pick<TenantContext, "role">) => can(ctx.role, "commission_earned.read") || can(ctx.role, "commission_earned.own");

function requireStatements(ctx: TenantContext): void {
  if (!canReadStatements(ctx)) throw new UserError("Your role does not include commission statements.");
}

export type Period = { from: string; to: string };

/** The members' names: the active sales team, and the email of anyone whose statement the reader may see. */
async function selectNames(tx: Tx, period: Period): Promise<Map<string, string>> {
  const [team, readable] = await Promise.all([
    tx.execute<{ user_id: string; email: string }>(sql`select user_id, email from app.sales_people()`),
    tx.execute<{ user_id: string; email: string | null }>(sql`select distinct user_id, email from app.commission_statement_summary(${period.from}::date, ${period.to}::date)`),
  ]);
  const names = new Map(team.map((row) => [row.user_id, row.email]));
  for (const row of readable) if (row.email && !names.has(row.user_id)) names.set(row.user_id, row.email);
  return names;
}

export type StatementPerson = PersonFigures & { name: string };

/**
 * The statements the reader may open for a period, each person's figures in short. `everyone`
 * is true for the owner, an accountant or the auditor; anyone else sees themself and their team.
 */
export async function listStatements(ctx: TenantContext, period: Period): Promise<{ everyone: boolean; people: StatementPerson[] }> {
  requireStatements(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [scope, rows, names] = await Promise.all([
      tx.execute<{ everyone: boolean; people: string[] | null }>(sql`select app.commission_statement_people() is null as everyone, app.commission_statement_people() as people`),
      tx.execute<{
        user_id: string;
        part: "opening" | "period";
        type: MovementType;
        amount: string;
      }>(sql`select user_id, part, type, amount::text from app.commission_statement_summary(${period.from}::date, ${period.to}::date)`),
      selectNames(tx, period),
    ]);
    const nameOf = (id: string) => names.get(id) ?? (id === ctx.userId ? ctx.email : "A former member");
    const figures = figuresByPerson(
      rows.map((row) => ({
        userId: row.user_id,
        part: row.part,
        type: row.type,
        amount: new Decimal(row.amount),
      })),
    );
    // The reader and their team are listed even before they have earned anything.
    const listed = new Set(figures.map((person) => person.userId));
    const nobody = {
      earned: new Decimal(0),
      released: new Decimal(0),
      paid: new Decimal(0),
    };
    for (const id of scope[0]?.people ?? [])
      if (!listed.has(id))
        figures.push({
          userId: id,
          opening: nobody,
          period: nobody,
          closing: nobody,
        });
    return {
      everyone: scope[0]?.everyone ?? false,
      people: figures.map((person) => ({ ...person, name: nameOf(person.userId) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** The Postgres code of a failed query, as the driver gives it (on the error, or on its cause). */
function codeOf(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

export type CommissionStatementData = Period & {
  person: { userId: string; name: string };
  statement: CommissionStatement;
};

type StatementRow = {
  seq: string;
  movement_date: string;
  type: MovementType;
  amount: string;
  source_type: string;
  source_id: string | null;
  source_number: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  customer_name: string | null;
  kind: "own" | "team" | null;
  seller_user_id: string | null;
  team_rate: string | null;
};

/** One person's statement for a period; null when there is no such person, or the reader may not see theirs. */
export async function getCommissionStatement(ctx: TenantContext, userId: string, period: Period): Promise<CommissionStatementData | null> {
  requireStatements(ctx);
  if (!isUuid(userId)) return null;
  const read = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    Promise.all([
      tx.execute<StatementRow>(sql`
        select seq::text, movement_date::text, type, amount::text, source_type, source_id, source_number,
               invoice_id, invoice_number, customer_name, kind, seller_user_id, team_rate::text
        from app.commission_statement(${userId}::uuid, ${period.from}::date, ${period.to}::date)`),
      selectNames(tx, period),
    ]),
  ).catch((error: unknown) => {
    // The database refuses a person the reader may not see, or who is not in the company.
    if (codeOf(error) === "42501") return null;
    throw error;
  });
  if (!read) return null;
  const [rows, names] = read;
  const nameOf = (id: string) => names.get(id) ?? (id === ctx.userId ? ctx.email : "A former member");
  const opening = figuresOf(rows.filter((row) => row.source_type === "opening").map((row) => ({ type: row.type, amount: new Decimal(row.amount) })));
  const movements = rows
    .filter((row) => row.source_type !== "opening")
    .map((row) => ({
      seq: Number(row.seq),
      date: row.movement_date,
      type: row.type,
      amount: new Decimal(row.amount),
      sourceType: row.source_type,
      sourceId: row.source_id ?? "",
      sourceNumber: row.source_number,
      invoiceId: row.invoice_id ?? "",
      invoiceNumber: row.invoice_number,
      customerName: row.customer_name,
      kind: row.kind ?? "own",
      sellerUserId: row.seller_user_id ?? userId,
      teamRate: row.team_rate === null ? null : new Decimal(row.team_rate),
    }));
  return { ...period, person: { userId, name: nameOf(userId) }, statement: buildCommissionStatement(opening, movements, nameOf, formatAmount) };
}
