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

/**
 * When each receipt or payment took effect: the date its allocations were posted (a cheque's clearing date, not the date it was
 * recorded) and, for a cheque that bounced after clearing, the date that posting was reversed. Receipts that never cleared have neither.
 */
function receiptPostings(w: Workspace) {
  const postedOn = new Map(w.journals.filter(j => j.status === "posted").map(j => [j.sourceId, j.date]));
  return new Map(w.receipts.map(r => {
    const cleared = postedOn.get(`${r.id}:cleared`) ?? (r.status === "cleared" ? r.date : undefined);
    const bounced = r.status === "bounced" && cleared ? postedOn.get(`${r.id}:bounce`) ?? cleared : undefined;
    return [r.id, { cleared, bounced }];
  }));
}

/**
 * Corrections, in each invoice's own currency, that turn today's outstanding into the open amount as at `asOf`: receipts that cleared
 * after `asOf` and returns dated after it are added back; a cheque that had cleared by `asOf` but bounced later is taken off again.
 */
function openAdjustments(w: Workspace, asOf: string) {
  const adjust = new Map<string, ReturnType<typeof D>>();
  const add = (invoiceId: string, amount: ReturnType<typeof D>) => adjust.set(invoiceId, (adjust.get(invoiceId) ?? D(0)).plus(amount));
  const postings = receiptPostings(w);
  for (const r of w.receipts) {
    const { cleared, bounced } = postings.get(r.id)!;
    const paidNow = r.status === "cleared"; // what `paid` holds today
    const paidThen = !!cleared && cleared <= asOf && !(bounced && bounced <= asOf);
    if (paidNow !== paidThen) for (const a of r.allocations) add(a.invoiceId, paidNow ? D(a.amount) : D(a.amount).negated());
  }
  for (const c of w.documents) if (c.parentId && (c.kind === "credit_note" || c.kind === "supplier_return") && c.status === "submitted" && c.date > asOf) add(c.parentId, D(c.total));
  return adjust;
}

export type AgedRow = { partyId: string; name: string; current: string; d30: string; d60: string; d90: string; over90: string; total: string };
/**
 * Open invoice balances bucketed by days past due as of a date. Unapplied credits (returns after payment) show as negatives in Current so totals tie to the control account.
 * Each invoice's open amount is rebuilt as at `asOf`: documents dated after it are excluded, and only receipts cleared and returns dated on or before it count.
 */
export function agedBalances(w: Workspace, partyType: "customer" | "supplier", asOf: string): { rows: AgedRow[]; totals: AgedRow } {
  const kind = partyType === "customer" ? "sales_invoice" : "supplier_invoice";
  const byParty = new Map<string, ReturnType<typeof D>[]>();
  const adjust = openAdjustments(w, asOf);
  for (const d of w.documents) {
    if (d.kind !== kind || d.status !== "submitted" || d.date > asOf) continue;
    const open = D(outstanding(d)).plus(adjust.get(d.id) ?? 0).mul(d.currency === "PKR" ? 1 : D(d.fxRate));
    if (open.isZero()) continue;
    const age = Math.floor((Date.parse(asOf) - Date.parse(d.dueDate)) / 86400000);
    const bucket = open.lt(0) ? 0 : age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4;
    const row = byParty.get(d.partyId) ?? [D(0), D(0), D(0), D(0), D(0)];
    row[bucket] = row[bucket].plus(open);
    byParty.set(d.partyId, row);
  }
  const toRow = (partyId: string, name: string, b: ReturnType<typeof D>[]): AgedRow => ({ partyId, name, current: money(b[0]), d30: money(b[1]), d60: money(b[2]), d90: money(b[3]), over90: money(b[4]), total: money(sum(b)) });
  const names = new Map(w.parties.map(p => [p.id, p.name]));
  const rows = [...byParty].map(([partyId, b]) => toRow(partyId, names.get(partyId) ?? partyId, b)).sort((a, b) => D(b.total).cmp(a.total));
  const totals = toRow("", "Total", [0, 1, 2, 3, 4].map(i => sum([...byParty.values()].map(b => b[i]))));
  return { rows, totals };
}

export type StatementLine = { date: string; reference: string; description: string; debit: string; credit: string; balance: string; documentId?: string };
/**
 * Party ledger in PKR. The balance is what the customer owes us, or what we owe the supplier, so both read the same way:
 * invoices and bills raise it (Debit column); receipts, payments, credit notes and returns to the supplier lower it (Credit column).
 * A cheque that bounced after clearing keeps its receipt line and is followed by a reversal line on the bounce date.
 */
export function partyStatement(w: Workspace, partyId: string, from: string, to: string): { opening: string; lines: StatementLine[]; closing: string } {
  const party = w.parties.find(p => p.id === partyId);
  const customer = party?.type !== "supplier";
  // Each event carries its effect on the balance: positive raises what is owed, negative lowers it.
  const events: { date: string; reference: string; description: string; amount: ReturnType<typeof D>; documentId?: string; order: number; step?: number }[] = [];
  for (const d of w.documents) {
    if (d.partyId !== partyId || d.status !== "submitted") continue;
    const value = D(d.total).mul(d.currency === "PKR" ? D(1) : D(d.fxRate));
    if (d.kind === "sales_invoice") events.push({ date: d.date, reference: d.number, description: "Sales invoice", amount: value, documentId: d.id, order: 1 });
    if (d.kind === "credit_note") events.push({ date: d.date, reference: d.number, description: "Credit note", amount: value.negated(), documentId: d.id, order: 2 });
    if (d.kind === "supplier_invoice") events.push({ date: d.date, reference: d.number, description: "Supplier bill", amount: value, documentId: d.id, order: 1 });
    if (d.kind === "supplier_return") events.push({ date: d.date, reference: d.number, description: "Return to supplier", amount: value.negated(), documentId: d.id, order: 2 });
  }
  const postings = receiptPostings(w);
  for (const r of w.receipts) {
    if (r.partyId !== partyId) continue;
    // Only receipts that posted appear: a cheque counts from its clearing date. One that bounced after clearing keeps its line and gets a reversal line.
    const { cleared, bounced } = postings.get(r.id)!;
    if (!cleared) continue;
    // In PKR at each bill's rate, the amount the payment clears from the party's account (any FX difference goes to 5400, not to the party).
    const amount = sum(r.allocations.map(a => { const d = w.documents.find(x => x.id === a.invoiceId); return D(a.amount).mul(d && d.currency !== "PKR" ? D(d.fxRate) : 1); }));
    const cheque = r.chequeNo ? ` ${r.chequeNo}` : "";
    events.push({ date: cleared, reference: r.number, description: customer ? `Receipt · ${r.method}${cheque}` : `Payment · ${r.method}${cheque}`, amount: amount.negated(), order: 3 });
    // On the same day the reversal follows its own receipt line, so a cheque re-received in cash later that day reads in order.
    if (bounced) events.push({ date: bounced, reference: r.number, description: `Cheque bounced${r.chequeNo ? ` · ${r.chequeNo}` : ""}`, amount, order: 3, step: 1 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.reference.localeCompare(b.reference) || (a.step ?? 0) - (b.step ?? 0));
  let balance = sum(events.filter(e => e.date < from).map(e => e.amount));
  const opening = money(balance);
  const lines: StatementLine[] = [];
  for (const e of events.filter(e => e.date >= from && e.date <= to)) {
    balance = balance.plus(e.amount);
    lines.push({ date: e.date, reference: e.reference, description: e.description, debit: e.amount.gt(0) ? money(e.amount) : "", credit: e.amount.lt(0) ? money(e.amount.negated()) : "", balance: money(balance), documentId: e.documentId });
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
/**
 * Net sales for a period grouped by customer, product or salesperson, from submitted invoices less credit notes.
 * By salesperson, a line with commission splits is apportioned by the split shares (net, returns and quantity, rounded to 4 dp); the last share takes the remainder so totals agree across groupings.
 */
export function salesAnalysis(w: Workspace, from: string, to: string, by: "customer" | "item" | "salesperson"): { rows: SalesRow[]; total: SalesRow } {
  const groups = new Map<string, { label: string; invoices: Set<string>; quantity: ReturnType<typeof D>; net: ReturnType<typeof D>; returns: ReturnType<typeof D> }>();
  const person = (employeeId: string) => [employeeId || "none", w.employees.find(e => e.id === employeeId)?.name ?? "Unassigned"];
  /** The groups a line belongs to, with each one's share of it. */
  const partsOf = (d: Document, l: Document["lines"][number]): { key: string; label: string; weight: ReturnType<typeof D> }[] => {
    if (by === "customer") return [{ key: d.partyId, label: w.parties.find(p => p.id === d.partyId)?.name ?? d.partyId, weight: D(1) }];
    if (by === "item") return [{ key: l.itemId, label: w.items.find(i => i.id === l.itemId)?.name ?? l.itemId, weight: D(1) }];
    const splits = l.splits?.filter(x => D(x.share).gt(0)) ?? [];
    if (!splits.length) { const [key, label] = person(l.employeeId); return [{ key, label, weight: D(1) }]; }
    const whole = sum(splits.map(x => x.share));
    return splits.map(x => { const [key, label] = person(x.employeeId); return { key, label, weight: D(x.share).div(whole) }; });
  };
  for (const d of w.documents) {
    if (!["sales_invoice", "credit_note"].includes(d.kind) || d.status !== "submitted" || d.date < from || d.date > to) continue;
    for (const l of d.lines) {
      const lineNet = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount)).div(100);
      const parts = partsOf(d, l);
      let restNet = lineNet, restQuantity = D(l.quantity);
      parts.forEach(({ key, label, weight }, i) => {
        const last = i === parts.length - 1;
        const net = last ? restNet : lineNet.mul(weight).toDecimalPlaces(4), quantity = last ? restQuantity : D(l.quantity).mul(weight).toDecimalPlaces(4);
        restNet = restNet.minus(net); restQuantity = restQuantity.minus(quantity);
        const g = groups.get(key) ?? { label, invoices: new Set(), quantity: D(0), net: D(0), returns: D(0) };
        if (d.kind === "sales_invoice") { g.invoices.add(d.id); g.quantity = g.quantity.plus(quantity); g.net = g.net.plus(net); } else g.returns = g.returns.plus(net);
        groups.set(key, g);
      });
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
