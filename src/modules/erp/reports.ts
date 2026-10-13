import { outstanding, stock } from "./engine";
import { D, money, sum } from "./money";
import { accountNames, type Document, type Workspace } from "./types";

/** Import charges credited to Accounts payable by landed-cost allocation, which have no supplier bill document. */
export function landedCostPayable(w: Workspace) {
  return money(sum(w.journals.filter(j => j.status === "posted" && j.memo.startsWith("Landed costs")).flatMap(j => j.lines.filter(l => l.account === "2000").map(l => D(l.credit).minus(l.debit)))));
}

/** Fixed chart plus the company's bank/cash accounts. */
export function chartOf(w: Workspace): Record<string, string> {
  return { ...accountNames, ...Object.fromEntries(w.bankAccounts.map(a => [a.code, `${a.name}${a.archived ? " (archived)" : ""}`])) };
}

const posted = (w: Workspace, from?: string, to?: string) => w.journals.filter(j => j.status === "posted" && (!from || j.date >= from) && (!to || j.date <= to));

export function balanceAt(w: Workspace, code: string, to?: string, from?: string) {
  return sum(posted(w, from, to).flatMap(j => j.lines.filter(l => l.account === code).map(l => D(l.debit).minus(l.credit))));
}

export type AgedRow = { partyId: string; name: string; current: string; d30: string; d60: string; d90: string; over90: string; total: string };
/** Open invoice balances bucketed by days past due as of a date. Unapplied credits (returns after payment) show as negatives in Current so totals tie to the control account. Documents dated after `asOf` are excluded; receipts are not back-dated. */
export function agedBalances(w: Workspace, partyType: "customer" | "supplier", asOf: string): { rows: AgedRow[]; totals: AgedRow } {
  const kind = partyType === "customer" ? "sales_invoice" : "supplier_invoice";
  const byParty = new Map<string, ReturnType<typeof D>[]>();
  for (const d of w.documents) {
    if (d.kind !== kind || d.status !== "submitted" || d.date > asOf) continue;
    const open = D(outstanding(d)).mul(d.currency === "PKR" ? 1 : D(d.fxRate));
    if (open.isZero()) continue;
    const age = Math.floor((Date.parse(asOf) - Date.parse(d.dueDate)) / 86400000);
    const bucket = open.lt(0) ? 0 : age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4;
    const row = byParty.get(d.partyId) ?? [D(0), D(0), D(0), D(0), D(0)];
    row[bucket] = row[bucket].plus(open);
    byParty.set(d.partyId, row);
  }
  const toRow = (partyId: string, name: string, b: ReturnType<typeof D>[]): AgedRow => ({ partyId, name, current: money(b[0]), d30: money(b[1]), d60: money(b[2]), d90: money(b[3]), over90: money(b[4]), total: money(sum(b)) });
  const rows = [...byParty].map(([partyId, b]) => toRow(partyId, w.parties.find(p => p.id === partyId)?.name ?? partyId, b)).sort((a, b) => D(b.total).cmp(a.total));
  const totals = toRow("", "Total", [0, 1, 2, 3, 4].map(i => sum([...byParty.values()].map(b => b[i]))));
  return { rows, totals };
}

export type StatementLine = { date: string; reference: string; description: string; debit: string; credit: string; balance: string; documentId?: string };
/** Party ledger in PKR: invoices debit a customer (credit a supplier), receipts/payments and returns the reverse. */
export function partyStatement(w: Workspace, partyId: string, from: string, to: string): { opening: string; lines: StatementLine[]; closing: string } {
  const party = w.parties.find(p => p.id === partyId);
  const sign = party?.type === "supplier" ? -1 : 1;
  const events: { date: string; reference: string; description: string; amount: ReturnType<typeof D>; documentId?: string; order: number }[] = [];
  for (const d of w.documents) {
    if (d.partyId !== partyId || d.status !== "submitted") continue;
    const fx = d.currency === "PKR" ? D(1) : D(d.fxRate);
    if (d.kind === "sales_invoice") events.push({ date: d.date, reference: d.number, description: "Sales invoice", amount: D(d.total).mul(fx), documentId: d.id, order: 1 });
    if (d.kind === "credit_note") events.push({ date: d.date, reference: d.number, description: "Credit note", amount: D(d.total).mul(fx).negated(), documentId: d.id, order: 2 });
    if (d.kind === "supplier_invoice") events.push({ date: d.date, reference: d.number, description: "Supplier bill", amount: D(d.total).mul(fx).negated(), documentId: d.id, order: 1 });
    if (d.kind === "supplier_return") events.push({ date: d.date, reference: d.number, description: "Return to supplier", amount: D(d.total).mul(fx), documentId: d.id, order: 2 });
  }
  for (const r of w.receipts) {
    if (r.partyId !== partyId || r.status !== "cleared") continue;
    const cleared = w.journals.find(j => j.sourceId === `${r.id}:cleared`);
    const date = cleared?.date ?? r.date;
    const amount = sum(r.allocations.map(a => { const d = w.documents.find(x => x.id === a.invoiceId); return D(a.amount).mul(d && d.currency !== "PKR" ? D(d.fxRate) : 1); }));
    events.push({ date, reference: r.number, description: sign > 0 ? `Receipt · ${r.method}${r.chequeNo ? ` ${r.chequeNo}` : ""}` : `Payment · ${r.method}`, amount: amount.negated(), order: 3 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.reference.localeCompare(b.reference));
  let balance = sum(events.filter(e => e.date < from).map(e => e.amount.mul(sign)));
  const opening = money(balance);
  const lines: StatementLine[] = [];
  for (const e of events.filter(e => e.date >= from && e.date <= to)) {
    const signed = e.amount.mul(sign);
    balance = balance.plus(signed);
    lines.push({ date: e.date, reference: e.reference, description: e.description, debit: signed.gt(0) ? money(signed) : "", credit: signed.lt(0) ? money(signed.negated()) : "", balance: money(balance), documentId: e.documentId });
  }
  return { opening, lines, closing: money(balance) };
}

export type StockRow = { itemId: string; sku: string; name: string; warehouseId: string; warehouse: string; quantity: string; average: string; value: string };
export function stockValuation(w: Workspace, warehouseId?: string): { rows: StockRow[]; total: string } {
  const rows: StockRow[] = [];
  for (const item of w.items) for (const wh of w.warehouses) {
    if (warehouseId && wh.id !== warehouseId) continue;
    const level = stock(w, item.id, wh.id);
    if (D(level.quantity).isZero() && D(level.value).isZero()) continue;
    rows.push({ itemId: item.id, sku: item.sku, name: item.name, warehouseId: wh.id, warehouse: wh.name, quantity: level.quantity, average: level.average, value: level.value });
  }
  return { rows, total: money(sum(rows.map(r => r.value))) };
}

export type MovementRow = { date: string; sku: string; name: string; warehouse: string; type: string; quantity: string; value: string; reference: string };
export function stockMovements(w: Workspace, from: string, to: string, itemId?: string): MovementRow[] {
  const refOf = (sourceId: string) => w.documents.find(d => d.id === sourceId)?.number ?? w.journals.find(j => j.sourceId === sourceId || j.id === sourceId)?.number ?? (sourceId.includes(":") ? "Landed cost" : sourceId === "opening-stock" ? "Opening" : "");
  return w.stockMoves.filter(m => m.date >= from && m.date <= to && (!itemId || m.itemId === itemId)).map(m => {
    const item = w.items.find(i => i.id === m.itemId);
    return { date: m.date, sku: item?.sku ?? "", name: item?.name ?? m.itemId, warehouse: w.warehouses.find(x => x.id === m.warehouseId)?.name ?? m.warehouseId, type: m.type.replaceAll("_", " "), quantity: m.quantity, value: m.value, reference: refOf(m.sourceId) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export type SalesRow = { key: string; label: string; invoices: number; quantity: string; net: string; returns: string; netOfReturns: string };
/** Net sales for a period grouped by customer, product or salesperson, from submitted invoices less credit notes. */
export function salesAnalysis(w: Workspace, from: string, to: string, by: "customer" | "item" | "salesperson"): { rows: SalesRow[]; total: SalesRow } {
  const groups = new Map<string, { label: string; invoices: Set<string>; quantity: ReturnType<typeof D>; net: ReturnType<typeof D>; returns: ReturnType<typeof D> }>();
  const keyOf = (d: Document, l: Document["lines"][number]) => by === "customer" ? [d.partyId, w.parties.find(p => p.id === d.partyId)?.name ?? d.partyId] : by === "item" ? [l.itemId, w.items.find(i => i.id === l.itemId)?.name ?? l.itemId] : [l.employeeId || "none", w.employees.find(e => e.id === l.employeeId)?.name ?? "Unassigned"];
  for (const d of w.documents) {
    if (!["sales_invoice", "credit_note"].includes(d.kind) || d.status !== "submitted" || d.date < from || d.date > to) continue;
    for (const l of d.lines) {
      const [key, label] = keyOf(d, l);
      const g = groups.get(key) ?? { label, invoices: new Set(), quantity: D(0), net: D(0), returns: D(0) };
      const lineNet = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount)).div(100);
      if (d.kind === "sales_invoice") { g.invoices.add(d.id); g.quantity = g.quantity.plus(l.quantity); g.net = g.net.plus(lineNet); } else g.returns = g.returns.plus(lineNet);
      groups.set(key, g);
    }
  }
  const rows = [...groups].map(([key, g]) => ({ key, label: g.label, invoices: g.invoices.size, quantity: money(g.quantity), net: money(g.net), returns: money(g.returns), netOfReturns: money(g.net.minus(g.returns)) })).sort((a, b) => D(b.netOfReturns).cmp(a.netOfReturns));
  const total = { key: "", label: "Total", invoices: rows.reduce((n, r) => n + r.invoices, 0), quantity: money(sum(rows.map(r => r.quantity))), net: money(sum(rows.map(r => r.net))), returns: money(sum(rows.map(r => r.returns))), netOfReturns: money(sum(rows.map(r => r.netOfReturns))) };
  return { rows, total };
}

export type LedgerRow = { code: string; name: string; amount: string };
export function profitAndLoss(w: Workspace, from: string, to: string) {
  const chart = chartOf(w);
  const codes = Object.keys(chart).filter(c => c.startsWith("4") || c.startsWith("5")).sort();
  const revenue: LedgerRow[] = [], expenses: LedgerRow[] = [];
  for (const code of codes) {
    const bal = balanceAt(w, code, to, from);
    if (bal.isZero()) continue;
    if (code.startsWith("4")) revenue.push({ code, name: chart[code], amount: money(bal.negated()) }); else expenses.push({ code, name: chart[code], amount: money(bal) });
  }
  const totalRevenue = sum(revenue.map(r => r.amount)), totalExpenses = sum(expenses.map(r => r.amount));
  return { revenue, expenses, totalRevenue: money(totalRevenue), totalExpenses: money(totalExpenses), netProfit: money(totalRevenue.minus(totalExpenses)) };
}

export function balanceSheet(w: Workspace, asOf: string) {
  const chart = chartOf(w);
  const section = (prefix: string, flip: boolean) => Object.keys(chart).filter(c => c.startsWith(prefix)).sort().map(code => ({ code, name: chart[code], amount: money(flip ? balanceAt(w, code, asOf).negated() : balanceAt(w, code, asOf)) })).filter(r => !D(r.amount).isZero());
  const assets = section("1", false), liabilities = section("2", true), equity = section("3", true);
  const earnings = sum([...Object.keys(chart).filter(c => c.startsWith("4") || c.startsWith("5"))].map(code => balanceAt(w, code, asOf).negated()));
  const totalAssets = sum(assets.map(r => r.amount)), totalLiabilities = sum(liabilities.map(r => r.amount)), totalEquity = sum(equity.map(r => r.amount)).plus(earnings);
  return { assets, liabilities, equity: [...equity, { code: "", name: "Retained earnings (current)", amount: money(earnings) }], totalAssets: money(totalAssets), totalLiabilities: money(totalLiabilities), totalEquity: money(totalEquity), difference: money(totalAssets.minus(totalLiabilities).minus(totalEquity)) };
}

export function trialBalance(w: Workspace, asOf: string) {
  const chart = chartOf(w);
  const rows = Object.keys(chart).sort().map(code => { const bal = balanceAt(w, code, asOf); return { code, name: chart[code], debit: bal.gt(0) ? money(bal) : "", credit: bal.lt(0) ? money(bal.negated()) : "" }; }).filter(r => r.debit || r.credit);
  return { rows, totalDebit: money(sum(rows.map(r => r.debit || 0))), totalCredit: money(sum(rows.map(r => r.credit || 0))) };
}

export type GlRow = { date: string; journal: string; memo: string; debit: string; credit: string; balance: string };
export function generalLedger(w: Workspace, code: string, from: string, to: string): { opening: string; rows: GlRow[]; closing: string } {
  let balance = balanceAt(w, code, undefined, undefined).minus(balanceAt(w, code, undefined, from)); // everything before `from`
  const opening = money(balance);
  const rows: GlRow[] = [];
  for (const j of posted(w, from, to).slice().sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))) {
    for (const l of j.lines.filter(l => l.account === code)) {
      balance = balance.plus(l.debit).minus(l.credit);
      rows.push({ date: j.date, journal: j.number, memo: j.memo, debit: D(l.debit).isZero() ? "" : l.debit, credit: D(l.credit).isZero() ? "" : l.credit, balance: money(balance) });
    }
  }
  return { opening, rows, closing: money(balance) };
}

/** Movements on a bank/cash account with a running balance, newest first. */
export function accountActivity(w: Workspace, code: string, limit = 50) {
  const gl = generalLedger(w, code, "0000-01-01", "9999-12-31");
  return { balance: gl.closing, rows: gl.rows.slice().reverse().slice(0, limit) };
}
