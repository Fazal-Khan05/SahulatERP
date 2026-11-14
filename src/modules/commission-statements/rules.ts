import Decimal from "decimal.js";

// Pure rules for a commission statement (Step 39): one person's commission over a period. No I/O.
//
// Everything that happens to commission is a movement that is written once and never changed
// (Step 38, drizzle/0027_commission_ledger.sql): earned when an invoice is posted, brought down
// when goods come back, released as the customer pays, taken back when a payment is undone,
// paid, and set against what a person owes back. A statement is nothing but those movements:
// what they came to before the period, each one in it, and what they come to at its end. So it
// always equals the movements for the period.

/** Step 38's movement types (src/modules/commission-ledger/rules.ts). */
export const MOVEMENT_TYPES = ["accrued", "entitlement_adjusted", "released", "release_reversed", "paid", "recovery_recorded"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const NIL = new Decimal(0);

/** The three figures a statement keeps: earned, released by the customers' money, and paid. */
export type Figures = { earned: Decimal; released: Decimal; paid: Decimal };

export const noFigures = (): Figures => ({
  earned: NIL,
  released: NIL,
  paid: NIL,
});
const plus = (a: Figures, b: Figures): Figures => ({
  earned: a.earned.plus(b.earned),
  released: a.released.plus(b.released),
  paid: a.paid.plus(b.paid),
});

/**
 * What one movement does to the figures. Step 38's rule, for every accrual: earned is accrued
 * plus entitlement_adjusted (which is never above nothing), released is released less
 * release_reversed, paid is paid less recovery_recorded.
 */
export function effectOf(type: MovementType, amount: Decimal): Figures {
  switch (type) {
    case "accrued":
    case "entitlement_adjusted":
      return { earned: amount, released: NIL, paid: NIL };
    case "released":
      return { earned: NIL, released: amount, paid: NIL };
    case "release_reversed":
      return { earned: NIL, released: amount.negated(), paid: NIL };
    case "paid":
      return { earned: NIL, released: NIL, paid: amount };
    case "recovery_recorded":
      return { earned: NIL, released: NIL, paid: amount.negated() };
  }
}

/** Movements added up. */
export const figuresOf = (movements: readonly { type: MovementType; amount: Decimal }[]): Figures => movements.reduce((total, movement) => plus(total, effectOf(movement.type, movement.amount)), noFigures());

/** Released and not yet paid: what is owed to the person. Below nothing, they owe it back. */
export const owedToThem = (figures: Figures) => figures.released.minus(figures.paid);
/** Earned and still waiting for the customers' money. */
export const waitingForCustomers = (figures: Figures) => figures.earned.minus(figures.released);

/** One movement as the statement reads it, with the documents it is about. */
export type StatementMovement = {
  /** The order the movements were written in. */
  seq: number;
  date: string;
  type: MovementType;
  amount: Decimal;
  /** What made it: sales_invoice, receipt, credit_note or commission_payment. */
  sourceType: string;
  sourceId: string;
  /** The receipt's, credit note's or payment's number; null when there is none. */
  sourceNumber: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  /** The person's own sale, or a share of a team member's sale (a manager's). */
  kind: "own" | "team";
  sellerUserId: string;
  /** A manager's team rate on the sale, in percent (the manager override percentage). */
  teamRate: Decimal | null;
};

export type StatementLine = {
  date: string;
  what: string;
  /** The invoice's number, or the payment's for a payment. */
  number: string | null;
  /** The invoice the line is about, for a link; null for a payment. */
  invoiceId: string | null;
  customerName: string | null;
  /** On a manager's share of a team member's sale: the team member. */
  teamMember: string | null;
  earned: Decimal;
  released: Decimal;
  paid: Decimal;
  /** What is owed to the person after this line: released less paid. Below nothing, they owe it back. */
  balance: Decimal;
};

export type CommissionStatement = {
  /** The figures before the period. */
  opening: Figures;
  lines: StatementLine[];
  /** What the period's movements come to. */
  period: Figures;
  /** opening plus period: the figures at the period's end. */
  closing: Figures;
};

/** "0.5" for a team rate of 0.5000 percent. */
const percent = (rate: Decimal) => rate.toFixed();

function words(movement: StatementMovement): string {
  const from = movement.sourceNumber ? ` (${movement.sourceNumber})` : "";
  const byCredit = movement.sourceType === "credit_note";
  switch (movement.type) {
    case "accrued":
      return movement.kind === "own" ? "Earned on the sale" : `Earned at the ${movement.teamRate ? percent(movement.teamRate) : "0"}% team rate`;
    case "entitlement_adjusted":
      return `Goods returned${from}`;
    case "released":
      return byCredit ? `Released: a credit note was set against the invoice${from}` : `Released: the customer paid${from}`;
    case "release_reversed":
      return byCredit ? `Release taken back: goods returned${from}` : `Release taken back: the customer's payment was undone${from}`;
    default:
      return "Commission paid";
  }
}

/** A payment's words: the approved commission paid, less what the person owed back. */
function paymentWords(gross: Decimal, recovered: Decimal, formatAmount: (amount: Decimal) => string): string {
  if (recovered.isZero()) return "Commission paid";
  if (gross.minus(recovered).isZero()) return `Commission of ${formatAmount(gross)} set against what was owed back`;
  return `Commission paid: ${formatAmount(gross)} approved, less ${formatAmount(recovered)} owed back`;
}

/**
 * The statement for a period. `opening` is every movement before the period, added up by type
 * (`figuresOf`); `movements` are the period's. A movement's lines are kept together when they
 * are one event on one invoice for one seller: an invoice of many lines is one line here. A
 * payment is one line, whatever it paid and whatever it took back.
 */
export function buildCommissionStatement(opening: Figures, movements: readonly StatementMovement[], nameOf: (userId: string) => string, formatAmount: (amount: Decimal) => string): CommissionStatement {
  type Group = {
    first: number;
    date: string;
    movement: StatementMovement;
    figures: Figures;
    gross: Decimal;
    recovered: Decimal;
  };
  const groups = new Map<string, Group>();
  for (const movement of [...movements].sort((a, b) => a.seq - b.seq)) {
    const isPayment = movement.type === "paid" || movement.type === "recovery_recorded";
    const key = isPayment
      ? `payment|${movement.sourceId}`
      : [movement.date, movement.sourceType, movement.sourceId, movement.type, movement.invoiceId, movement.kind, movement.sellerUserId, movement.teamRate?.toFixed() ?? ""].join("|");
    const group = groups.get(key) ?? {
      first: movement.seq,
      date: movement.date,
      movement,
      figures: noFigures(),
      gross: NIL,
      recovered: NIL,
    };
    group.figures = plus(group.figures, effectOf(movement.type, movement.amount));
    if (movement.type === "paid") group.gross = group.gross.plus(movement.amount);
    if (movement.type === "recovery_recorded") group.recovered = group.recovered.plus(movement.amount);
    groups.set(key, group);
  }

  let balance = owedToThem(opening);
  const lines = [...groups.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.first - b.first))
    .map((group): StatementLine => {
      const { movement, figures } = group;
      const isPayment = movement.type === "paid" || movement.type === "recovery_recorded";
      balance = balance.plus(owedToThem(figures));
      return {
        date: group.date,
        what: isPayment ? paymentWords(group.gross, group.recovered, formatAmount) : words(movement),
        number: isPayment ? movement.sourceNumber : movement.invoiceNumber,
        invoiceId: isPayment ? null : movement.invoiceId,
        customerName: isPayment ? null : movement.customerName,
        teamMember: !isPayment && movement.kind === "team" ? nameOf(movement.sellerUserId) : null,
        earned: figures.earned,
        released: figures.released,
        paid: figures.paid,
        balance,
      };
    });
  const period = figuresOf(movements);
  return { opening, lines, period, closing: plus(opening, period) };
}

/** One person's figures for the statements list. */
export type PersonFigures = {
  userId: string;
  opening: Figures;
  period: Figures;
  closing: Figures;
};

/**
 * Everyone's figures for a period, from movements added up by person, part and type: what came
 * before the period (`opening`) and what happened in it (`period`).
 */
export function figuresByPerson(
  rows: readonly {
    userId: string;
    part: "opening" | "period";
    type: MovementType;
    amount: Decimal;
  }[],
): PersonFigures[] {
  const people = new Map<string, PersonFigures>();
  for (const row of rows) {
    const person = people.get(row.userId) ?? {
      userId: row.userId,
      opening: noFigures(),
      period: noFigures(),
      closing: noFigures(),
    };
    const effect = effectOf(row.type, row.amount);
    person[row.part] = plus(person[row.part], effect);
    person.closing = plus(person.closing, effect);
    people.set(row.userId, person);
  }
  return [...people.values()];
}

/** The PDF's file name: the person's name, and the period. Only letters, digits and dashes. */
export function statementFileName(name: string, from: string, to: string): string {
  const who =
    name
      .split("@")[0]
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "commission";
  return `commission-${who}-${from}-to-${to}.pdf`;
}

/** This month so far, and the whole of last month, for the quick choices of a period. */
export function monthChoices(today: string): {
  thisMonth: { from: string; to: string };
  lastMonth: { from: string; to: string };
} {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const [lastYear, last] = month === 1 ? [year - 1, 12] : [year, month - 1];
  const pad = (value: number) => String(value).padStart(2, "0");
  const lastDay = new Date(Date.UTC(lastYear, last, 0)).getUTCDate();
  return {
    thisMonth: { from: `${today.slice(0, 8)}01`, to: today },
    lastMonth: {
      from: `${lastYear}-${pad(last)}-01`,
      to: `${lastYear}-${pad(last)}-${pad(lastDay)}`,
    },
  };
}
