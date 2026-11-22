import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import Decimal from "decimal.js";
import { closeDb } from "@/db";
import { savePlan } from "@/modules/commissions/commands";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addItemCategory, addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt as postGoodsReceipt, saveOrderDraft, saveReceiptDraft as saveGoodsReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import { clearCheque, depositCheque, postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import { postPayment, savePaymentDraft } from "@/modules/supplier-payments/commands";
import { setModuleEnabled } from "@/modules/tenant/commands";
import { MODULES, type MemberRole, type TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, type AdminSql } from "../../tests/support/admin-db";

// The performance company (Step 50): an invented distributor with months of trading
// and 100,000 sales invoices, built through the app's own commands and posting functions, day by
// day, as people would through the screens. Nothing here writes a document, a stock move or a
// journal itself. Run by `npm run perf:seed` against a LOCAL database (`npm run db:local`), or a
// development one named in PERF_DATABASE_OK; it refuses any other. Every name in it is made up.
//
// The size is PERF_INVOICES (100,000 unless said). A run that stops can be started again: it
// goes on from the day after the last one it finished.
//
// One process posts about a dozen invoices a second, so the work can be shared out: start
// PERF_SHARDS processes, each with its own PERF_SHARD (0, 1, ...). Each sells its own share of
// every day; the first also sets the company up and does the buying, and the others wait for it.

export const PERF_COMPANY = "Perf Distributors (Seed)";
// The day the tax rates a new company starts with come into force: nothing is taxed before it.
const FIRST_DAY = "2026-07-01";
const WORKERS = 5; // the app's pool holds five connections

/** A local database, or one the person running this has named as safe to fill. */
export function assertSafeDatabase(): void {
  for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL"] as const) {
    const url = process.env[name];
    if (!url) throw new Error(`${name} is not set.`);
    const host = new URL(url).hostname;
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const named = (process.env.PERF_DATABASE_OK ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    if (!local && !named.some((ok) => url.includes(ok))) {
      throw new Error(`${name} is not a local database. The performance seed fills a database with 100,000 invoices: run it against one made by npm run db:local.`);
    }
  }
}

const shift = (iso: string, days: number) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** The same numbers every run, so that two seeds of one size are the same company. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (from: number, to: number) => from + Math.floor(next() * (to - from + 1)), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] };
}

/** Runs the jobs a few at a time. One that fails is tried again, then counted and left. */
async function inParallel<T>(jobs: readonly T[], run: (job: T) => Promise<void>, failed: { count: number; first: string[] }): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      for (let attempt = 1; ; attempt += 1) {
        try {
          await run(job);
          break;
        } catch (error) {
          if (attempt < 3) continue;
          failed.count += 1;
          if (failed.first.length < 20) failed.first.push(error instanceof Error ? error.message.slice(0, 300) : String(error));
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
}

type Receivable = { customerId: string; invoiceId: string; amount: string; method: "cash" | "bank" | "cheque" };
type Payable = { supplierId: string; billId: string; branchId: string };

async function findSeed(sql: AdminSql): Promise<{ id: string; created_by: string } | undefined> {
  return (await sql<{ id: string; created_by: string }[]>`select id, created_by from public.tenants where name = ${PERF_COMPANY}`)[0];
}

/** Progress is said on the screen and, where PERF_LOG names a file, written there too. */
function say(line: string): void {
  console.log(line);
  if (process.env.PERF_LOG) appendFileSync(process.env.PERF_LOG, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

export async function seedPerf(log: (line: string) => void = say): Promise<string[]> {
  assertSafeDatabase();
  const wanted = Number(process.env.PERF_INVOICES ?? 100_000);
  if (!Number.isInteger(wanted) || wanted < 100) throw new Error("PERF_INVOICES: a whole number, 100 or more.");
  const lastDay = process.env.PERF_LAST_DAY ?? shift(new Date().toISOString().slice(0, 10), -1);
  const days = daysBetween(FIRST_DAY, lastDay) + 1;
  const shards = Number(process.env.PERF_SHARDS ?? 1);
  const shard = Number(process.env.PERF_SHARD ?? 0);
  if (!Number.isInteger(shards) || !Number.isInteger(shard) || shards < 1 || shard < 0 || shard >= shards) throw new Error("PERF_SHARD: 0 up to one less than PERF_SHARDS.");
  const sql = adminSql();
  const said: string[] = [];
  const failed = { count: 0, first: [] as string[] };
  try {
    // (A schema of its own: nothing of the app's, and no company's rows, live in it.)
    await sql`create schema if not exists perf_seed`.catch(() => undefined);
    await sql`create table if not exists perf_seed.progress (tenant_id uuid not null, shard int not null, state jsonb not null, primary key (tenant_id, shard))`.catch(() => undefined);
    if (shard > 0) {
      // The first process makes the company; this one starts once that one has finished a day.
      for (let waited = 0; ; waited += 1) {
        const ready = await sql`select 1 from perf_seed.progress p join public.tenants t on t.id = p.tenant_id where t.name = ${PERF_COMPANY} and p.shard = 0`;
        if (ready.length > 0) break;
        if (waited > 600) throw new Error("The first process (PERF_SHARD=0) has not set the company up.");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    // ── The company ─────────────────────────────────────────────────────────────────────────────
    let found = await findSeed(sql);
    const fresh = !found;
    const tenantId = found?.id ?? randomUUID();
    const ownerId = found?.created_by ?? randomUUID();
    const as = (userId: string, role: MemberRole): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@perf.sahulaterp.test`, tenantId, tenantName: PERF_COMPANY, role, branchIds: null });
    const owner = as(ownerId, "owner");
    if (fresh) {
      const sellerIds = Array.from({ length: 5 }, () => randomUUID());
      await sql`insert into public.tenants (id, name, created_by) values (${tenantId}, ${PERF_COMPANY}, ${ownerId})`;
      await sql`insert into public.memberships ${sql([
        { tenant_id: tenantId, user_id: ownerId, email: owner.email, role: "owner", branch_ids: null, created_by: ownerId },
        ...sellerIds.map((id) => ({ tenant_id: tenantId, user_id: id, email: as(id, "salesperson").email, role: "salesperson", branch_ids: null, created_by: ownerId })),
      ])}`;
      await sql`insert into public.company_setup (tenant_id, sales_tax_registered, strn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantId}, true, '3277876000019', now(), 'trading', ${ownerId})`;
      await sql`select app.seed_tax_defaults(${tenantId}, ${ownerId})`;
      for (const [name, warehouse] of [["Karachi", "Karachi warehouse"], ["Lahore", "Lahore warehouse"]]) {
        const [branch] = await sql<{ id: string }[]>`insert into public.branches (tenant_id, name, created_by) values (${tenantId}, ${name}, ${ownerId}) returning id`;
        await sql`insert into public.warehouses (tenant_id, branch_id, name, created_by) values (${tenantId}, ${branch.id}, ${warehouse}, ${ownerId})`;
      }
      await setBaseCurrency(owner, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(owner, "trading");
      await openFiscalYear(owner, { month: "7", year: FIRST_DAY.slice(0, 4) }, { onlyFirst: true });
      for (const key of MODULES) await setModuleEnabled(owner, key, true);
      await setWithholding(owner, true);
      await savePlan(owner, null, { name: "Standard plan", kind: "flat", rate: "2", from: FIRST_DAY, to: "" });
    }
    found = (await findSeed(sql))!;
    const sellers = (await sql<{ user_id: string }[]>`select user_id from public.memberships where tenant_id = ${tenantId} and role = 'salesperson' order by user_id`).map((row) => as(row.user_id, "salesperson"));
    const warehouses = await sql<{ id: string; branch_id: string }[]>`select id, branch_id from public.warehouses where tenant_id = ${tenantId} order by name`;

    // Fiscal years up to the last day.
    for (let year = +FIRST_DAY.slice(0, 4) + 1; `${year}-07-01` <= lastDay; year += 1) {
      const open = await sql`select 1 from public.fiscal_periods where tenant_id = ${tenantId} and starts_on = ${`${year}-07-01`}`;
      if (open.length === 0) await openFiscalYear(owner, { month: "7", year: String(year) });
    }

    // ── Money accounts, items, customers, suppliers ─────────────────────────────────────────────
    const [{ id: cash }] = await sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and code = '1111'`;
    let bank = (await sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and name = 'Meezan Bank current account'`)[0]?.id;
    if (!bank) {
      const [{ id: banks }] = await sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and code = '1120'`;
      bank = (await addAccount(owner, { parentId: banks, name: "Meezan Bank current account", code: "", kind: "account" })).id;
    }

    const setUp = random(50);
    const ITEMS = 300;
    const CUSTOMERS = 500;
    const SUPPLIERS = 40;
    const none = async (table: "items" | "stock_moves" | "customers" | "suppliers") => (await sql`select 1 from ${sql(`public.${table}`)} where tenant_id = ${tenantId} limit 1`).length === 0;
    // Each part is made once, so a run that stopped half-way through the set-up goes on from there.
    if (await none("items")) {
      const piece = (await addUnit(owner, { code: "pc", name: "Piece" })).id;
      const categories: string[] = [];
      for (const name of ["Brakes", "Lighting", "Engine parts", "Tyres and tubes", "Accessories", "Electrical", "Body parts", "Oils", "Bearings", "Tools"]) categories.push((await addItemCategory(owner, name)).id);
      for (let n = 1; n <= ITEMS; n += 1) {
        const price = setUp.int(1, 60) * 50;
        await createItem(owner, { code: `IT-${String(n).padStart(4, "0")}`, name: `Part ${n}`, unit: piece, category: categories[n % categories.length], defaultPrice: String(price), hsCode: `8714.${String(1000 + (n % 90) * 10)}`, reorderLevel: "200" });
      }
    }
    if (await none("stock_moves")) {
      // Opening stock at about two thirds of the selling price, 150 lines to a document.
      const priced = await sql<{ code: string; default_price: string }[]>`select code, default_price::text from public.items where tenant_id = ${tenantId} order by code`;
      for (const warehouse of warehouses) {
        for (let from = 0; from < priced.length; from += 150) {
          const { id } = await saveAdjustmentDraft(owner, "opening", null, {
            date: FIRST_DAY, warehouseId: warehouse.id, note: "Stock counted when the company started using the app",
            lines: priced.slice(from, from + 150).map((item) => ({ itemCode: item.code, direction: "in", quantity: "6000", unitCost: new Decimal(item.default_price).mul("0.65").toFixed(0) })),
          });
          await postAdjustment(owner, id);
        }
      }
    }
    if (await none("customers")) {
      const cities: [string, string][] = [["Karachi", "sindh"], ["Hyderabad", "sindh"], ["Lahore", "punjab"], ["Faisalabad", "punjab"], ["Multan", "punjab"], ["Peshawar", "kpk"]];
      for (let n = 1; n <= CUSTOMERS; n += 1) {
        const [city, province] = cities[n % cities.length];
        await createParty(owner, "customer", {
          name: `Customer ${n} Traders`, code: `C-${String(n).padStart(4, "0")}`, creditDays: String([7, 15, 30, 45][n % 4]), city, province,
          customerClass: ["Wholesaler", "Retailer", "Workshop"][n % 3],
          // Three in five are registered for sales tax; the rest are sold to with further tax.
          ...(n % 5 < 3 ? { registrationType: "registered", ntn: String(1_000_000 + n), strn: String(3_277_876_000_000 + n) } : {}),
        });
      }
    }
    if (await none("suppliers")) {
      for (let n = 1; n <= SUPPLIERS; n += 1) {
        await createParty(owner, "supplier", n % 2 === 0 ? { name: `Supplier ${n} (Pvt) Ltd`, supplierType: "company", ntn: String(7_000_000 + n) } : { name: `Supplier ${n} Brothers`, supplierType: "aop" });
      }
      said.push(`Company "${PERF_COMPANY}" set up: 2 branches, ${ITEMS} items with opening stock, ${CUSTOMERS} customers, ${SUPPLIERS} suppliers.`);
    }
    const items = await sql<{ id: string; default_price: string }[]>`select id, default_price::text from public.items where tenant_id = ${tenantId} order by code`;
    const customers = await sql<{ id: string; credit_days: number }[]>`select id, credit_days from public.customers where tenant_id = ${tenantId} order by code`;
    const suppliers = await sql<{ id: string; supplier_type: string }[]>`select id, supplier_type from public.suppliers where tenant_id = ${tenantId} order by name`;

    // ── Trading, a day at a time ────────────────────────────────────────────────────────────────
    // What is still to come in or go out on a later day is kept in the database between runs.
    const saved = (await sql<{ state: { lastDay: string | null; invoices: number; receivables: Record<string, Receivable[]>; payables: Record<string, Payable[]>; returns: Record<string, string[]> } }[]>`select state from perf_seed.progress where tenant_id = ${tenantId} and shard = ${shard}`)[0]?.state;
    const state = saved ?? { lastDay: null, invoices: 0, receivables: {}, payables: {}, returns: {} };
    const started = Date.now();
    const startedAt = state.invoices;
    let billNo = (await sql<{ n: number }[]>`select count(*)::int as n from public.supplier_bills where tenant_id = ${tenantId}`)[0].n;

    for (let index = 0; index < days; index += 1) {
      const date = shift(FIRST_DAY, index);
      if (state.lastDay && date <= state.lastDay) continue;
      const dice = random(1000 + index);
      // The invoices of the day: the same share of the whole each day, so the last day ends on the number asked for.
      const count = Math.round((wanted * (index + 1)) / days) - Math.round((wanted * index) / days);

      // Buying: goods ordered, received and billed, to be paid a month on.
      await inParallel(
        shard === 0 ? Array.from({ length: Math.max(1, Math.round(count / 35)) }, (_, n) => n) : [],
        async (n) => {
          const local = random(index * 1000 + n + 7);
          const supplier = local.pick(suppliers);
          const warehouse = local.pick(warehouses);
          const lines = Array.from({ length: 8 }, () => local.pick(items)).filter((item, at, all) => all.findIndex((other) => other.id === item.id) === at);
          const order = await saveOrderDraft(owner, null, { date, supplierId: supplier.id, warehouseId: warehouse.id, lines: lines.map((item) => ({ itemId: item.id, quantity: String(local.int(60, 160)), unitCost: new Decimal(item.default_price).mul("0.65").toFixed(0) })) });
          await submitOrder(owner, order.id);
          const placed = (await getOrder(owner, order.id))!;
          const note = await saveGoodsReceiptDraft(owner, null, order.id, { date, lines: placed.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
          await postGoodsReceipt(owner, note.id);
          const received = await sql<{ id: string; quantity: string; unit_cost: string }[]>`select l.id, l.quantity::text, o.unit_cost::text from public.goods_receipt_lines l join public.purchase_order_lines o on o.id = l.order_line_id where l.tenant_id = ${tenantId} and l.receipt_id = ${note.id}`;
          const bill = await saveBillDraft(owner, null, {
            date, supplierId: supplier.id, branchId: warehouse.branch_id, supplierInvoiceNo: `PINV-${(billNo += 1)}`,
            goods: received.map((line) => ({ receiptLineId: line.id, quantity: line.quantity, unitPrice: line.unit_cost })),
            ...(supplier.supplier_type === "company" ? { incomeTaxCode: "income_tax.goods.company" } : {}),
          });
          await postBill(owner, bill.id);
          if (local.next() < 0.85) (state.payables[shift(date, local.int(20, 45))] ??= []).push({ supplierId: supplier.id, billId: bill.id, branchId: warehouse.branch_id });
        },
        failed,
      );

      // Selling.
      await inParallel(
        Array.from({ length: count }, (_, n) => n).filter((n) => n % shards === shard),
        async (n) => {
          const local = random(index * 100_000 + n + 13);
          const customer = local.pick(customers);
          const writer = local.pick(sellers);
          const warehouse = local.pick(warehouses);
          const lines = Array.from({ length: local.int(1, 5) }, () => local.pick(items)).filter((item, at, all) => all.findIndex((other) => other.id === item.id) === at);
          const { id } = await saveSalesDraft(writer, null, {
            kind: "order", date, validUntil: "", customerId: customer.id, warehouseId: warehouse.id,
            lines: lines.map((item) => ({ itemId: item.id, quantity: String(local.int(1, 6)), unitId: "", unitPrice: "", discountPercent: local.next() < 0.2 ? "5" : "", description: "" })),
            shares: [{ userId: writer.userId, percent: "100" }],
          });
          await submitSalesDocument(writer, id);
          let billFrom = id;
          if (local.next() < 0.1) {
            // One sale in ten goes out on a delivery note first.
            const note = (await startDelivery(owner, id)).id;
            const draft = (await getSalesDocument(owner, note))!;
            await saveDeliveryDraft(owner, note, { date, lines: draft.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity.toFixed() })) });
            await postDelivery(owner, note);
            billFrom = note;
          }
          const invoice = (await startInvoice(owner, billFrom)).id;
          const draft = (await getSalesDocument(owner, invoice))!;
          await saveInvoiceDraft(owner, invoice, { date, lines: draft.lines.map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity.toFixed() })) });
          await postInvoice(owner, invoice);
          state.invoices += 1;
          // Most are paid about when they fall due; one in twenty in part; one in ten not at all.
          const fate = local.next();
          const total = draft.totals.total;
          if (fate < 0.9) {
            const amount = fate < 0.05 ? total.div(2).toDecimalPlaces(0, Decimal.ROUND_DOWN) : total;
            const method = local.next() < 0.3 ? "cash" : local.next() < 0.7 ? "bank" : "cheque";
            (state.receivables[shift(date, Math.max(0, customer.credit_days + local.int(-5, 30)))] ??= []).push({ customerId: customer.id, invoiceId: invoice, amount: amount.toFixed(2), method });
          }
          if (local.next() < 0.02) (state.returns[shift(date, local.int(2, 9))] ??= []).push(invoice);
        },
        failed,
      );

      // Goods that come back.
      await inParallel(
        state.returns[date] ?? [],
        async (invoiceId) => {
          const billed = (await getSalesDocument(owner, invoiceId))!;
          const { id } = await startCreditNote(owner, invoiceId);
          await saveCreditNoteDraft(owner, id, { date, notes: "Sent back: wrong size.", reference: "", lines: [{ sourceLineId: billed.lines[0].id, quantity: "1", damaged: "0" }] });
          await postCreditNote(owner, id);
        },
        failed,
      );
      delete state.returns[date];

      // Money in.
      await inParallel(
        state.receivables[date] ?? [],
        async (due) => {
          const { id } = await saveReceiptDraft(owner, null, {
            date, customerId: due.customerId, method: due.method, accountId: due.method === "cash" ? cash : due.method === "bank" ? bank : "", amount: due.amount,
            chequeNumber: due.method === "cheque" ? String(10_000_000 + dice.int(0, 89_999_999)) : "", chequeBank: due.method === "cheque" ? "HBL" : "", chequeDate: due.method === "cheque" ? date : "",
            allocations: [{ kind: "invoice", id: due.invoiceId, amount: due.amount }],
          });
          await postReceipt(owner, id);
          // Cheques of the last fortnight are still in hand; older ones were deposited and cleared.
          if (due.method === "cheque" && daysBetween(date, lastDay) > 14) {
            await depositCheque(owner, id, { accountId: bank, date });
            await clearCheque(owner, id, { date });
          }
        },
        failed,
      );
      delete state.receivables[date];

      // Money out.
      await inParallel(
        state.payables[date] ?? [],
        async (due) => {
          const [bill] = await sql<{ payable: string }[]>`select payable::text from public.supplier_bills where tenant_id = ${tenantId} and id = ${due.billId}`;
          const pay = await savePaymentDraft(owner, null, { date, supplierId: due.supplierId, branchId: due.branchId, accountId: bank, amount: bill.payable, allocations: [{ billId: due.billId, amount: bill.payable }] });
          await postPayment(owner, pay.id, pay.updatedAt);
        },
        failed,
      );
      delete state.payables[date];

      // A day on which much went wrong is not a company worth measuring: stop and say why.
      if (failed.count > 20 && failed.count > state.invoices / 50) throw new Error(`${failed.count} documents failed by ${date}. The first: ${[...new Set(failed.first)].join(" | ")}`);
      state.lastDay = date;
      await sql`insert into perf_seed.progress (tenant_id, shard, state) values (${tenantId}, ${shard}, ${sql.json(state)}) on conflict (tenant_id, shard) do update set state = excluded.state`;
      if (index % 10 === 0 || index === days - 1) {
        const rate = (state.invoices - startedAt) / ((Date.now() - started) / 1000);
        log(`${shards > 1 ? `[${shard}] ` : ""}${date}: ${state.invoices} invoices so far, ${rate.toFixed(1)} a second, ${failed.count} documents failed`);
      }
    }

    const [counts] = await sql<{ invoices: number; lines: number; journals: number; journal_lines: number; moves: number; receipts: number }[]>`
      select (select count(*) from public.sales_documents where tenant_id = ${tenantId} and kind = 'invoice' and status = 'submitted')::int as invoices,
             (select count(*) from public.sales_lines where tenant_id = ${tenantId})::int as lines,
             (select count(*) from public.journals where tenant_id = ${tenantId})::int as journals,
             (select count(*) from public.journal_lines where tenant_id = ${tenantId})::int as journal_lines,
             (select count(*) from public.stock_moves where tenant_id = ${tenantId})::int as moves,
             (select count(*) from public.receipts where tenant_id = ${tenantId})::int as receipts`;
    said.push(`${counts.invoices} posted invoices, ${counts.lines} sales lines, ${counts.receipts} receipts, ${counts.journals} journals with ${counts.journal_lines} lines, ${counts.moves} stock moves, up to ${lastDay}.`);
    if (failed.count > 0) said.push(`${failed.count} documents failed and were left out. The first: ${failed.first.join(" | ")}`);
    await sql`analyze`;
    for (const line of said) log(line);
    return said;
  } finally {
    await sql.end();
    await closeDb();
  }
}

/** Removes the performance company, and only it. */
export async function resetPerf(): Promise<string[]> {
  assertSafeDatabase();
  const sql = adminSql();
  try {
    const found = await findSeed(sql);
    if (!found) return ["There is no performance company to remove."];
    await sql`delete from perf_seed.progress where tenant_id = ${found.id}`.catch(() => undefined);
    await deleteTenants(sql, [found.id]);
    return ["Removed the performance company."];
  } finally {
    await sql.end();
    await closeDb();
  }
}
