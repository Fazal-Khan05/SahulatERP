import type Decimal from "decimal.js";
import type { TenantContext } from "@/modules/tenant/rules";
import type { AdminSql } from "../../tests/support/admin-db";

// What the parts of the demo seed share: who is signed in as what, the days it all happens on,
// and the ids of what earlier parts made. Filled in by seed.ts as the company is built.

export type DemoInvoice = { customer: string; id: string; number: string; total: Decimal; month: 0 | 1 };

export type Demo = {
  sql: AdminSql;
  /** What the seed did, in sentences, printed at the end. No password is ever among them. */
  said: string[];
  /** Document numbers and figures the walk in docs/DEMO.md quotes, checked and printed at the end. */
  facts: Record<string, string>;
  tenantId: string;
  people: Record<string, { id: string; email: string }>;
  owner: TenantContext;
  accountant: TenantContext;
  manager: TenantContext;
  ali: TenantContext;
  sana: TenantContext;
  payroll: TenantContext;
  warehouse: TenantContext;
  recovery: TenantContext;
  auditor: TenantContext;
  /** Days are counted in Pakistan, as the app counts them. */
  today: string;
  yesterday: string;
  lastMonth: string;
  thisMonth: string;
  /** A day in last month (0) or this month (1), never later than yesterday. */
  day: (month: 0 | 1, n: number) => string;
  shift: (iso: string, days: number) => string;
  fyYear: number;
  karachiBranch: string;
  lahoreBranch: string;
  /** The warehouses: Karachi, Lahore, and the shop counter in Karachi made for the transfer. */
  karachi: string;
  lahore: string;
  shop: string;
  units: { piece: string; set: string };
  categories: Record<string, string>;
  /** Item ids by code, and customers' ids by code. */
  items: Record<string, string>;
  customers: Record<string, string>;
  suppliers: Record<string, string>;
  /** Cash in hand (1111), the bank account, and petty cash. */
  cash: string;
  bank: string;
  petty: string;
  invoices: DemoInvoice[];
};

/** An account's id by its code. */
export async function accountId(d: Demo, code: string): Promise<string> {
  const [row] = await d.sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${d.tenantId} and code = ${code}`;
  if (!row) throw new Error(`The demo's chart has no account ${code}.`);
  return row.id;
}
