import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { contacts, customers, partyAddresses } from "@/modules/parties/schema";
import { memberships } from "@/modules/tenant/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { ageOpenItems, buildStatement, promiseState, type CustomerAgeing, type OpenItem, type PromiseState, type Statement } from "./rules";
import { customerFollowUps } from "./schema";

// Recovery read models. What a customer owes always comes from app.receivables_open (Step 32),
// and their statement from app.customer_statement (this step's migration): both run as the
// table owner after asking who is reading, and show a member limited to some branches only
// those branches' invoices and lines.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

export function requireRecoveryAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "recovery.read")) throw new UserError("Your role does not include recovery.");
}

type OpenRow = { customer_id: string; code: string | null; name: string; kind: string; item_id: string; number: string | null; document_date: string; due_date: string; total: string; settled: string; outstanding: string };

const openItem = (row: Omit<OpenRow, "customer_id" | "code" | "name">): OpenItem => ({
  kind: row.kind === "opening" ? "opening" : "invoice",
  id: row.item_id,
  number: row.number,
  date: row.document_date,
  dueDate: row.due_date,
  total: d(row.total),
  settled: d(row.settled),
  outstanding: d(row.outstanding),
});

/** Every customer who owes anything, aged as at `today`. The overdue list and the aged receivables report are both this. */
export async function listCustomerAgeing(ctx: TenantContext, today: string): Promise<CustomerAgeing[]> {
  requireRecoveryAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<OpenRow>(sql`
      select c.id as customer_id, c.code, c.name, r.kind, r.id as item_id, r.number, r.document_date::text, r.due_date::text,
        r.total::text, r.settled::text, r.outstanding::text
      from public.customers c cross join lateral app.receivables_open(c.id) r
      where c.tenant_id = ${ctx.tenantId}
      order by c.id, r.due_date`),
  );
  const byCustomer = new Map<string, { customer: { customerId: string; code: string | null; name: string }; items: OpenItem[] }>();
  for (const row of rows) {
    const entry = byCustomer.get(row.customer_id) ?? { customer: { customerId: row.customer_id, code: row.code, name: row.name }, items: [] };
    entry.items.push(openItem(row));
    byCustomer.set(row.customer_id, entry);
  }
  return [...byCustomer.values()].map((entry) => ageOpenItems(entry.customer, entry.items, today));
}

export type FollowUpRow = { id: string; customerId: string; customerName: string; note: string; nextOn: string | null; createdAt: Date; by: string };
export type PromiseRow = { id: string; customerId: string; customerName: string; amount: Decimal; madeOn: string; promisedOn: string; note: string | null; received: Decimal; state: PromiseState; createdAt: Date; by: string };

/** Who wrote a row, by email where this member may see it. */
async function namesOf(tx: Tx, ctx: TenantContext & { email?: string }): Promise<(userId: string) => string> {
  const rows = await tx.select({ userId: memberships.userId, email: memberships.email }).from(memberships).where(eq(memberships.tenantId, ctx.tenantId));
  const names = new Map(rows.map((row) => [row.userId, row.email]));
  return (userId) => (userId === ctx.userId ? "you" : (names.get(userId) ?? "another member"));
}

type StoredPromise = Omit<PromiseRow, "by"> & { createdBy: string };

async function selectPromises(tx: Tx, ctx: TenantContext, today: string, customerId: string | null): Promise<StoredPromise[]> {
  const rows = await tx.execute<{ id: string; customer_id: string; customer_name: string; amount: string; made_on: string; promised_on: string; note: string | null; received: string; created_at: Date; created_by: string }>(sql`
    select p.id, p.customer_id, c.name as customer_name, p.amount::text, p.made_on::text, p.promised_on::text, p.note,
      app.customer_received(p.customer_id, p.made_on, p.promised_on)::text as received, p.created_at, p.created_by
    from public.payment_promises p join public.customers c on c.tenant_id = p.tenant_id and c.id = p.customer_id
    where p.tenant_id = ${ctx.tenantId} and (${customerId}::uuid is null or p.customer_id = ${customerId}::uuid)
    order by p.promised_on desc, p.created_at desc
    limit 500`);
  return rows.map((row) => {
    const amount = d(row.amount);
    const received = d(row.received);
    return { id: row.id, customerId: row.customer_id, customerName: row.customer_name, amount, madeOn: row.made_on, promisedOn: row.promised_on, note: row.note, received, state: promiseState({ amount, promisedOn: row.promised_on }, received, today), createdAt: new Date(row.created_at), createdBy: row.created_by };
  });
}

export type CustomerRecovery = {
  id: string;
  code: string | null;
  name: string;
  items: OpenItem[];
  ageing: CustomerAgeing;
  followUps: FollowUpRow[];
  promises: PromiseRow[];
};

/** One customer's recovery page: what they owe, invoice by invoice, what was said, and what they promised. */
export async function getCustomerRecovery(ctx: TenantContext, customerId: string, today: string): Promise<CustomerRecovery | null> {
  requireRecoveryAccess(ctx);
  if (!isUuid(customerId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [customer] = await tx.select({ id: customers.id, code: customers.code, name: customers.name }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, customerId)));
    if (!customer) return null;
    const [open, notes, promises, nameOf] = await Promise.all([
      tx.execute<Omit<OpenRow, "customer_id" | "code" | "name">>(sql`select kind, id as item_id, number, document_date::text, due_date::text, total::text, settled::text, outstanding::text from app.receivables_open(${customerId}::uuid)`),
      tx
        .select({ id: customerFollowUps.id, note: customerFollowUps.note, nextOn: customerFollowUps.nextOn, createdAt: customerFollowUps.createdAt, createdBy: customerFollowUps.createdBy })
        .from(customerFollowUps)
        .where(and(eq(customerFollowUps.tenantId, ctx.tenantId), eq(customerFollowUps.customerId, customerId)))
        .orderBy(desc(customerFollowUps.createdAt))
        .limit(200),
      selectPromises(tx, ctx, today, customerId),
      namesOf(tx, ctx),
    ]);
    const items = open.map(openItem);
    return {
      ...customer,
      items,
      ageing: ageOpenItems({ customerId: customer.id, code: customer.code, name: customer.name }, items, today),
      followUps: notes.map((note) => ({ ...note, customerId, customerName: customer.name, by: nameOf(note.createdBy) })),
      promises: promises.map((promise) => ({ ...promise, by: nameOf(promise.createdBy) })),
    };
  });
}

/** The follow-ups due today or earlier: each customer's latest follow-up, where it asked to follow up by now. */
export async function listFollowUpsDue(ctx: TenantContext, today: string): Promise<FollowUpRow[]> {
  requireRecoveryAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [rows, nameOf] = await Promise.all([
      tx.execute<{ id: string; customer_id: string; customer_name: string; note: string; next_on: string | null; created_at: Date; created_by: string }>(sql`
        select l.id, l.customer_id, c.name as customer_name, l.note, l.next_on::text, l.created_at, l.created_by
        from (select distinct on (f.customer_id) f.* from public.customer_follow_ups f where f.tenant_id = ${ctx.tenantId} order by f.customer_id, f.created_at desc) l
        join public.customers c on c.tenant_id = l.tenant_id and c.id = l.customer_id
        where l.next_on is not null and l.next_on <= ${today}::date
        order by l.next_on, lower(c.name)`),
      namesOf(tx, ctx),
    ]);
    return rows.map((row) => ({ id: row.id, customerId: row.customer_id, customerName: row.customer_name, note: row.note, nextOn: row.next_on, createdAt: new Date(row.created_at), by: nameOf(row.created_by) }));
  });
}

/** Promises to pay across the company, newest first: the follow-ups screen lists the broken and those due soon. */
export async function listPromises(ctx: TenantContext, today: string): Promise<PromiseRow[]> {
  requireRecoveryAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [rows, nameOf] = await Promise.all([selectPromises(tx, ctx, today, null), namesOf(tx, ctx)]);
    return rows.map((row) => ({ ...row, by: nameOf(row.createdBy) }));
  });
}

/** The latest follow-up date and promise state of each customer, for the overdue list. */
export async function listRecoveryMarks(ctx: TenantContext, today: string): Promise<Map<string, { nextOn: string | null; brokenPromises: number }>> {
  requireRecoveryAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [next, promises] = await Promise.all([
      tx.execute<{ customer_id: string; next_on: string | null }>(sql`
        select distinct on (customer_id) customer_id, next_on::text from public.customer_follow_ups
        where tenant_id = ${ctx.tenantId} order by customer_id, created_at desc`),
      selectPromises(tx, ctx, today, null),
    ]);
    const marks = new Map<string, { nextOn: string | null; brokenPromises: number }>();
    for (const row of next) marks.set(row.customer_id, { nextOn: row.next_on, brokenPromises: 0 });
    for (const promise of promises) {
      if (promise.state !== "broken") continue;
      const mark = marks.get(promise.customerId) ?? { nextOn: null, brokenPromises: 0 };
      marks.set(promise.customerId, { ...mark, brokenPromises: mark.brokenPromises + 1 });
    }
    return marks;
  });
}

export type CustomerStatement = {
  customer: { id: string; code: string | null; name: string; ntn: string | null; address: string | null; email: string | null };
  from: string;
  to: string;
  statement: Statement;
  open: OpenItem[];
};

/** A customer's statement for a period, from the receivables account, with their open invoices. */
export async function getCustomerStatement(ctx: TenantContext, customerId: string, period: { from: string; to: string }): Promise<CustomerStatement | null> {
  requireRecoveryAccess(ctx);
  if (!isUuid(customerId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [customer] = await tx.select({ id: customers.id, code: customers.code, name: customers.name, ntn: customers.ntn }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, customerId)));
    if (!customer) return null;
    const [lines, open, [address], [contact]] = await Promise.all([
      tx.execute<{ line_date: string; written_at: Date; source_type: string; document_number: string | null; debit: string; credit: string }>(sql`
        select line_date::text, written_at, source_type, document_number, debit::text, credit::text
        from app.customer_statement(${customerId}::uuid, ${period.from}::date, ${period.to}::date)`),
      tx.execute<Omit<OpenRow, "customer_id" | "code" | "name">>(sql`select kind, id as item_id, number, document_date::text, due_date::text, total::text, settled::text, outstanding::text from app.receivables_open(${customerId}::uuid)`),
      tx
        .select({ line: partyAddresses.line, city: partyAddresses.city })
        .from(partyAddresses)
        .where(and(eq(partyAddresses.tenantId, ctx.tenantId), eq(partyAddresses.customerId, customerId)))
        .orderBy(desc(partyAddresses.isPrimary), asc(partyAddresses.createdAt))
        .limit(1),
      tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.customerId, customerId), sql`${contacts.email} is not null`))
        .orderBy(desc(contacts.isPrimary), asc(contacts.createdAt))
        .limit(1),
    ]);
    const [opening, ...rest] = lines;
    return {
      customer: { ...customer, address: address ? [address.line, address.city].filter(Boolean).join(", ") || null : null, email: contact?.email ?? null },
      from: period.from,
      to: period.to,
      statement: buildStatement(
        { debit: d(opening?.debit), credit: d(opening?.credit) },
        rest.map((line) => ({ date: line.line_date, writtenAt: new Date(line.written_at), sourceType: line.source_type, number: line.document_number, debit: d(line.debit), credit: d(line.credit) })),
      ),
      open: open.map(openItem),
    };
  });
}

/** Customers to choose a statement for, by name or code. */
export async function findRecoveryCustomers(ctx: TenantContext, typed: string): Promise<{ id: string; code: string | null; name: string }[]> {
  requireRecoveryAccess(ctx);
  const search = typed.trim().toLowerCase();
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: customers.id, code: customers.code, name: customers.name })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenantId), search === "" ? undefined : sql`(lower(${customers.name}) like ${`%${search.replace(/[\\%_]/g, "\\$&")}%`} or lower(coalesce(${customers.code}, '')) like ${`%${search.replace(/[\\%_]/g, "\\$&")}%`})`))
      .orderBy(asc(sql`lower(${customers.name})`))
      .limit(50),
  );
}
