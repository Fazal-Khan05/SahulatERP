import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { AtlStatus, PartyInput, PartyKind, Province, RegistrationType, SupplierType } from "./rules";
import { contacts, customers, partyAddresses, suppliers } from "./schema";

export type PartyTable = typeof customers | typeof suppliers;
export const partyTable = (kind: PartyKind): PartyTable => (kind === "customer" ? customers : suppliers);

const NO_ACCESS: Record<PartyKind, string> = {
  customer: "Your role does not include the customer list.",
  supplier: "Your role does not include the supplier list.",
};

export function requirePartyAccess(ctx: TenantContext, kind: PartyKind): void {
  if (!can(ctx.role, kind === "customer" ? "customer.read" : "supplier.read")) throw new UserError(NO_ACCESS[kind]);
}

/** A party with its primary contact and address, as the database holds it. */
export type StoredParty = {
  id: string;
  party: PartyInput;
  atlCheckedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  code: string | null;
  name: string;
  registrationType: RegistrationType;
  ntn: string | null;
  cnic: string | null;
  strn: string | null;
  atlStatus: AtlStatus;
  atlCheckedAt: Date | null;
  province: Province | null;
  creditDays: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  creditLimit: string | null;
  customerClass: string | null;
  isWithholdingAgent: boolean;
  supplierType: SupplierType | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
};

const stored = (row: Row): StoredParty => ({
  id: row.id,
  atlCheckedAt: row.atlCheckedAt,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  party: {
    code: row.code,
    name: row.name,
    registrationType: row.registrationType,
    ntn: row.ntn,
    cnic: row.cnic,
    strn: row.strn,
    atlStatus: row.atlStatus,
    province: row.province,
    creditDays: row.creditDays,
    creditLimit: row.creditLimit,
    customerClass: row.customerClass,
    isWithholdingAgent: row.isWithholdingAgent,
    supplierType: row.supplierType,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
  },
});

/**
 * Parties of one kind with their primary contact and address, by name. Inside a transaction the
 * caller already holds, so commands can read what they are about to change.
 */
export async function selectParties(
  tx: Tx,
  tenantId: string,
  kind: PartyKind,
  where: SQL | undefined,
  limit: number,
): Promise<StoredParty[]> {
  const shared = (t: PartyTable) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    registrationType: t.registrationType,
    ntn: t.ntn,
    cnic: t.cnic,
    strn: t.strn,
    atlStatus: t.atlStatus,
    atlCheckedAt: t.atlCheckedAt,
    province: t.province,
    creditDays: t.creditDays,
    archivedAt: t.archivedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    contactName: contacts.name,
    phone: contacts.phone,
    email: contacts.email,
    address: partyAddresses.line,
    city: partyAddresses.city,
  });
  const rows: Row[] =
    kind === "customer"
      ? await tx
          .select({
            ...shared(customers),
            creditLimit: customers.creditLimit,
            customerClass: customers.customerClass,
            isWithholdingAgent: customers.isWithholdingAgent,
            supplierType: sql<SupplierType | null>`null`,
          })
          .from(customers)
          .leftJoin(contacts, and(eq(contacts.tenantId, customers.tenantId), eq(contacts.customerId, customers.id), eq(contacts.isPrimary, true)))
          .leftJoin(
            partyAddresses,
            and(eq(partyAddresses.tenantId, customers.tenantId), eq(partyAddresses.customerId, customers.id), eq(partyAddresses.isPrimary, true)),
          )
          .where(and(eq(customers.tenantId, tenantId), where))
          .orderBy(asc(sql`lower(${customers.name})`))
          .limit(limit)
      : await tx
          .select({
            ...shared(suppliers),
            creditLimit: sql<string | null>`null`,
            customerClass: sql<string | null>`null`,
            isWithholdingAgent: sql<boolean>`false`,
            supplierType: suppliers.supplierType,
          })
          .from(suppliers)
          .leftJoin(contacts, and(eq(contacts.tenantId, suppliers.tenantId), eq(contacts.supplierId, suppliers.id), eq(contacts.isPrimary, true)))
          .leftJoin(
            partyAddresses,
            and(eq(partyAddresses.tenantId, suppliers.tenantId), eq(partyAddresses.supplierId, suppliers.id), eq(partyAddresses.isPrimary, true)),
          )
          .where(and(eq(suppliers.tenantId, tenantId), where))
          .orderBy(asc(sql`lower(${suppliers.name})`))
          .limit(limit);
  return rows.map(stored);
}

export const PARTY_LIST_LIMIT = 200;

export type PartyListRow = {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  phone: string | null;
  ntn: string | null;
  atlStatus: AtlStatus;
  creditLimit: Decimal | null;
  creditDays: number | null;
  customerClass: string | null;
  supplierType: SupplierType | null;
};

/**
 * The list screen: live parties, or the archived ones, by name. `search` matches part of the
 * name, code, city or phone. Returns at most PARTY_LIST_LIMIT rows and says when there are more.
 */
export async function listParties(
  ctx: TenantContext,
  kind: PartyKind,
  options: { search?: string; archived?: boolean },
): Promise<{ rows: PartyListRow[]; more: boolean }> {
  requirePartyAccess(ctx, kind);
  const table = partyTable(kind);
  const term = (options.search ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  // % and _ mean "anything" to LIKE; typed by a person they mean themselves.
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const matches =
    term === ""
      ? undefined
      : sql`(${table.name} ilike ${pattern} or ${table.code} ilike ${pattern} or ${partyAddresses.city} ilike ${pattern} or ${contacts.phone} ilike ${pattern})`;
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    selectParties(tx, ctx.tenantId, kind, and(options.archived ? isNotNull(table.archivedAt) : isNull(table.archivedAt), matches), PARTY_LIST_LIMIT + 1),
  );
  return {
    more: found.length > PARTY_LIST_LIMIT,
    rows: found.slice(0, PARTY_LIST_LIMIT).map(({ id, party }) => ({
      id,
      code: party.code,
      name: party.name,
      city: party.city,
      phone: party.phone,
      ntn: party.ntn,
      atlStatus: party.atlStatus,
      creditLimit: party.creditLimit === null ? null : new Decimal(party.creditLimit),
      creditDays: party.creditDays,
      customerClass: party.customerClass,
      supplierType: party.supplierType,
    })),
  };
}

/** One party, archived or not, or null when it is not this company's. */
export async function getParty(ctx: TenantContext, kind: PartyKind, id: string): Promise<StoredParty | null> {
  requirePartyAccess(ctx, kind);
  if (!isUuid(id)) return null;
  const [found] = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectParties(tx, ctx.tenantId, kind, eq(partyTable(kind).id, id), 1));
  return found ?? null;
}
