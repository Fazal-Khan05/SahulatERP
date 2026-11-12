import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { partyTable, selectParties } from "./queries";
import { PARTY_WORDS, partyChanges, readParty, readPartyImport, type ImportProblem, type PartyInput, type PartyKind, type RawParty } from "./rules";
import { contacts, customers, partyAddresses, suppliers } from "./schema";

// Customers and suppliers are added, changed, archived and restored; never deleted. Every
// command writes its audit row in the same transaction as the change.

const UNIQUE_VIOLATION = "23505";
const INSERT_CHUNK = 250;

function requireManager(ctx: TenantContext, kind: PartyKind): void {
  if (!can(ctx.role, kind === "customer" ? "customer.manage" : "supplier.manage")) {
    throw new UserError(
      kind === "customer"
        ? "Only an owner, an accountant or a sales manager can change customers."
        : "Only an owner or an accountant can change suppliers.",
    );
  }
}

/** Which unique rule a refused insert or update broke: the name's or the code's. */
function taken(kind: PartyKind, error: unknown): UserError | null {
  if (pgCode(error) !== UNIQUE_VIOLATION) return null;
  const e = error as { constraint_name?: string; cause?: { constraint_name?: string } };
  const constraint = e.cause?.constraint_name ?? e.constraint_name ?? "";
  const one = PARTY_WORDS[kind].one;
  return new UserError(constraint.endsWith("_code_key") ? `Another ${one} already has this code.` : `A ${one} with this name already exists.`);
}

/** The columns both kinds of party share, from a cleaned party. */
const sharedValues = (party: PartyInput) => ({
  code: party.code,
  name: party.name,
  registrationType: party.registrationType,
  ntn: party.ntn,
  cnic: party.cnic,
  strn: party.strn,
  atlStatus: party.atlStatus,
  province: party.province,
  creditDays: party.creditDays,
});
const customerValues = (party: PartyInput) => ({
  ...sharedValues(party),
  creditLimit: party.creditLimit,
  customerClass: party.customerClass,
  isWithholdingAgent: party.isWithholdingAgent,
});
const supplierValues = (party: PartyInput) => ({ ...sharedValues(party), supplierType: party.supplierType ?? ("company" as const) });

const hasContact = (party: PartyInput) => party.contactName !== null || party.phone !== null || party.email !== null;
const hasAddress = (party: PartyInput) => party.address !== null || party.city !== null;

/** Writes new parties with their contact and address rows. Ids are made here so the rows can point at each other in one round of inserts. */
async function insertParties(tx: Tx, ctx: TenantContext, kind: PartyKind, list: { id: string; party: PartyInput }[]): Promise<void> {
  const by = { tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId };
  const owner = (id: string) => (kind === "customer" ? { customerId: id } : { supplierId: id });
  for (let start = 0; start < list.length; start += INSERT_CHUNK) {
    const chunk = list.slice(start, start + INSERT_CHUNK);
    // The moment the status was recorded, for a party that arrives with one.
    const checked = (party: PartyInput) => (party.atlStatus === "unknown" ? null : sql`now()`);
    if (kind === "customer") {
      await tx.insert(customers).values(chunk.map(({ id, party }) => ({ id, ...by, ...customerValues(party), atlCheckedAt: checked(party) })));
    } else {
      await tx.insert(suppliers).values(chunk.map(({ id, party }) => ({ id, ...by, ...supplierValues(party), atlCheckedAt: checked(party) })));
    }
    const people = chunk.filter(({ party }) => hasContact(party));
    if (people.length > 0) {
      await tx.insert(contacts).values(people.map(({ id, party }) => ({ ...by, ...owner(id), name: party.contactName, phone: party.phone, email: party.email })));
    }
    const places = chunk.filter(({ party }) => hasAddress(party));
    if (places.length > 0) {
      await tx.insert(partyAddresses).values(places.map(({ id, party }) => ({ ...by, ...owner(id), line: party.address, city: party.city })));
    }
  }
}

function cleaned(kind: PartyKind, raw: RawParty): PartyInput {
  const read = readParty(kind, raw);
  if (!read.ok) throw new UserError(read.problems[0]);
  return read.party;
}

/** Adds a customer or a supplier. */
export async function createParty(ctx: TenantContext, kind: PartyKind, raw: RawParty): Promise<{ id: string }> {
  requireManager(ctx, kind);
  const party = cleaned(kind, raw);
  const id = randomUUID();
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      await insertParties(tx, ctx, kind, [{ id, party }]);
      await audit(tx, ctx, { action: `${kind}.create`, entity: kind, entityId: id, after: party });
    });
  } catch (error) {
    throw taken(kind, error) ?? error;
  }
  return { id };
}

/** Locks the party's row for the rest of the transaction and returns it as it stands. */
async function lockParty(tx: Tx, ctx: TenantContext, kind: PartyKind, id: string) {
  const table = partyTable(kind);
  const mine = and(eq(table.tenantId, ctx.tenantId), eq(table.id, id));
  const locked = kind === "customer" ? await tx.select({ id: customers.id }).from(customers).where(mine).for("update") : await tx.select({ id: suppliers.id }).from(suppliers).where(mine).for("update");
  if (locked.length === 0) throw new UserError(`That ${PARTY_WORDS[kind].one} is not in this company.`);
  const [found] = await selectParties(tx, ctx.tenantId, kind, eq(table.id, id), 1);
  return { found, mine };
}

/**
 * Changes a customer or a supplier. Only the fields that differ are written to the audit row,
 * each with its old and new value. An archived party must be restored first.
 */
export async function updateParty(
  ctx: TenantContext,
  kind: PartyKind,
  id: unknown,
  raw: RawParty,
  /** When the form being saved was loaded: the party's `updatedAt` then, as ISO text. */
  loadedAt?: unknown,
): Promise<{ id: string }> {
  requireManager(ctx, kind);
  if (!isUuid(id)) throw new UserError(`That ${PARTY_WORDS[kind].one} is not in this company.`);
  const party = cleaned(kind, raw);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const { found, mine } = await lockParty(tx, ctx, kind, id);
      if (found.archivedAt !== null) throw new UserError(`Restore the ${PARTY_WORDS[kind].one} before changing it.`);
      // The form holds every field as it was when the page was opened. Saved over a newer
      // version it would quietly undo someone else's change, so it is refused instead.
      if (typeof loadedAt === "string" && loadedAt !== "" && loadedAt !== found.updatedAt.toISOString()) {
        throw new UserError(`Someone else changed this ${PARTY_WORDS[kind].one} while you had it open. Reload the page to see their change, then make yours.`);
      }
      const changes = partyChanges(found.party, party);
      if (Object.keys(changes.after).length === 0) return;

      const stamp = { updatedAt: sql`now()`, updatedBy: ctx.userId };
      // The check time moves only when the status itself changes.
      const checked = party.atlStatus === found.party.atlStatus ? {} : { atlCheckedAt: party.atlStatus === "unknown" ? null : sql`now()` };
      if (kind === "customer") await tx.update(customers).set({ ...customerValues(party), ...checked, ...stamp }).where(mine);
      else await tx.update(suppliers).set({ ...supplierValues(party), ...checked, ...stamp }).where(mine);

      const by = { tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId };
      const owner = kind === "customer" ? { customerId: id } : { supplierId: id };
      const primaryContact = and(eq(contacts.tenantId, ctx.tenantId), eq(kind === "customer" ? contacts.customerId : contacts.supplierId, id), eq(contacts.isPrimary, true));
      const contact = { name: party.contactName, phone: party.phone, email: party.email };
      if (!hasContact(party)) await tx.delete(contacts).where(primaryContact);
      else if (hasContact(found.party)) await tx.update(contacts).set({ ...contact, ...stamp }).where(primaryContact);
      else await tx.insert(contacts).values({ ...by, ...owner, ...contact });

      const primaryAddress = and(
        eq(partyAddresses.tenantId, ctx.tenantId),
        eq(kind === "customer" ? partyAddresses.customerId : partyAddresses.supplierId, id),
        eq(partyAddresses.isPrimary, true),
      );
      const place = { line: party.address, city: party.city };
      if (!hasAddress(party)) await tx.delete(partyAddresses).where(primaryAddress);
      else if (hasAddress(found.party)) await tx.update(partyAddresses).set({ ...place, ...stamp }).where(primaryAddress);
      else await tx.insert(partyAddresses).values({ ...by, ...owner, ...place });

      await audit(tx, ctx, { action: `${kind}.update`, entity: kind, entityId: id, before: changes.before, after: changes.after });
    });
  } catch (error) {
    throw taken(kind, error) ?? error;
  }
  return { id };
}

/**
 * Archives a party, which hides it from lists and pickers, or restores it. Nothing is deleted,
 * and documents that name the party stay as they are.
 */
export async function setPartyArchived(ctx: TenantContext, kind: PartyKind, id: unknown, archived: boolean): Promise<void> {
  requireManager(ctx, kind);
  if (!isUuid(id)) throw new UserError(`That ${PARTY_WORDS[kind].one} is not in this company.`);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const { found, mine } = await lockParty(tx, ctx, kind, id);
    if ((found.archivedAt !== null) === archived) return;
    const values = {
      archivedAt: archived ? sql`now()` : null,
      archivedBy: archived ? ctx.userId : null,
      updatedAt: sql`now()`,
      updatedBy: ctx.userId,
    };
    if (kind === "customer") await tx.update(customers).set(values).where(mine);
    else await tx.update(suppliers).set(values).where(mine);
    await audit(tx, ctx, {
      action: archived ? `${kind}.archive` : `${kind}.restore`,
      entity: kind,
      entityId: id,
      before: { name: found.party.name, archived: !archived },
      after: { name: found.party.name, archived },
    });
  });
}

export type ImportOutcome = { imported: number } | { problems: ImportProblem[] };

/**
 * Imports a CSV file of customers or suppliers, all or nothing. If any row is wrong, or names a
 * party that already exists, no row is kept and every bad row is returned with what is wrong.
 */
export async function importParties(ctx: TenantContext, kind: PartyKind, file: { name: string; text: string }): Promise<ImportOutcome> {
  requireManager(ctx, kind);
  const read = readPartyImport(kind, file.text);
  if (read.status === "unreadable") throw new UserError(read.reason);
  // Rows wrong in themselves. The rows that read cleanly are still checked against the parties
  // already there, so one upload lists everything to correct.
  const inFile = read.status === "rejected" ? read.problems : [];
  if (read.parties.length === 0) return { problems: inFile };

  const one = PARTY_WORDS[kind].one;
  const table = partyTable(kind);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx): Promise<ImportOutcome> => {
      // Archived parties count too: their names and codes are still taken.
      const existing = await tx
        .select({ name: sql<string>`lower(${table.name})`, code: sql<string | null>`lower(${table.code})` })
        .from(table)
        .where(eq(table.tenantId, ctx.tenantId));
      const names = new Set(existing.map((row) => row.name));
      const codes = new Set(existing.map((row) => row.code).filter((code) => code !== null));
      const problems: ImportProblem[] = [...inFile];
      for (const { row, party } of read.parties) {
        const found: string[] = [];
        if (names.has(party.name.toLowerCase())) found.push(`A ${one} with this name already exists.`);
        if (party.code !== null && codes.has(party.code.toLowerCase())) found.push(`Another ${one} already has this code.`);
        if (found.length > 0) problems.push({ row, name: party.name, problems: found });
      }
      if (problems.length > 0) return { problems: problems.sort((a, b) => a.row - b.row) };

      const list = read.parties.map(({ party }) => ({ id: randomUUID(), party }));
      await insertParties(tx, ctx, kind, list);
      await audit(tx, ctx, {
        action: `${kind}.import`,
        entity: kind,
        // The ids tie each imported party back to this import; it has no audit row of its own.
        after: { rows: list.length, file: file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 120), ids: list.map((item) => item.id) },
      });
      return { imported: list.length };
    });
  } catch (error) {
    // A name or code was taken between the check and the insert: the whole file is refused.
    if (pgCode(error) === UNIQUE_VIOLATION) {
      throw new UserError(`A ${one} in the file has a name or code that is already taken. Nothing was imported; import the file again to see which row.`);
    }
    throw error;
  }
}
