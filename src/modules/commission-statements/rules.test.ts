import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { formatAmount } from "@/lib/money";
import { buildCommissionStatement, effectOf, figuresByPerson, figuresOf, monthChoices, noFigures, owedToThem, statementFileName, waitingForCustomers, type StatementMovement } from "./rules";

const D = (value: string | number) => new Decimal(value);
const names: Record<string, string> = {
  ali: "ali@example.test",
  imran: "imran@example.test",
};
const nameOf = (id: string) => names[id] ?? "A former member";

let seq = 0;
const move = (over: Partial<StatementMovement> & Pick<StatementMovement, "type" | "amount" | "date">): StatementMovement => ({
  seq: ++seq,
  sourceType: "sales_invoice",
  sourceId: "si5",
  sourceNumber: null,
  invoiceId: "si5",
  invoiceNumber: "SI-2627-00005",
  customerName: "Ahmed Traders",
  kind: "own",
  sellerUserId: "ali",
  teamRate: null,
  ...over,
});

const opening = figuresOf([
  { type: "accrued", amount: D(1000) },
  { type: "released", amount: D(600) },
  { type: "paid", amount: D(600) },
]);

/** Ali's November: a sale of two lines, a cheque that bounces, a return, the customer pays, and a payment. */
const november = (): StatementMovement[] => [
  move({ type: "accrued", amount: D(300), date: "2026-11-03" }),
  move({ type: "accrued", amount: D(200), date: "2026-11-03" }),
  move({
    type: "released",
    amount: D(250),
    date: "2026-11-05",
    sourceType: "receipt",
    sourceId: "rc7",
    sourceNumber: "RC-2627-00007",
  }),
  move({
    type: "release_reversed",
    amount: D(250),
    date: "2026-11-08",
    sourceType: "receipt",
    sourceId: "rc7",
    sourceNumber: "RC-2627-00007",
  }),
  move({
    type: "entitlement_adjusted",
    amount: D(-100),
    date: "2026-11-10",
    sourceType: "credit_note",
    sourceId: "cn2",
    sourceNumber: "CN-2627-00002",
  }),
  move({
    type: "released",
    amount: D(400),
    date: "2026-11-12",
    sourceType: "receipt",
    sourceId: "rc9",
    sourceNumber: "RC-2627-00009",
  }),
  move({
    type: "paid",
    amount: D(300),
    date: "2026-11-20",
    sourceType: "commission_payment",
    sourceId: "cp1",
    sourceNumber: "CP-2627-00001",
  }),
  move({
    type: "paid",
    amount: D(100),
    date: "2026-11-20",
    sourceType: "commission_payment",
    sourceId: "cp1",
    sourceNumber: "CP-2627-00001",
  }),
];

const plain = (amount: Decimal) => amount.toFixed(2);

describe("effectOf", () => {
  it("moves each figure the way Step 38 adds them up", () => {
    const f = (type: Parameters<typeof effectOf>[0]) => Object.values(effectOf(type, D(5))).map(plain);
    expect(f("accrued")).toEqual(["5.00", "0.00", "0.00"]);
    expect(Object.values(effectOf("entitlement_adjusted", D(-5))).map(plain)).toEqual(["-5.00", "0.00", "0.00"]);
    expect(f("released")).toEqual(["0.00", "5.00", "0.00"]);
    expect(f("release_reversed")).toEqual(["0.00", "-5.00", "0.00"]);
    expect(f("paid")).toEqual(["0.00", "0.00", "5.00"]);
    expect(f("recovery_recorded")).toEqual(["0.00", "0.00", "-5.00"]);
  });
});

describe("buildCommissionStatement", () => {
  it("equals the movements for the period, line by line and in total", () => {
    const movements = november();
    const statement = buildCommissionStatement(opening, movements, nameOf, formatAmount);
    const sum = (pick: (line: (typeof statement.lines)[number]) => Decimal) => statement.lines.reduce((total, line) => total.plus(pick(line)), D(0));
    const moved = figuresOf(movements);
    expect([sum((l) => l.earned), sum((l) => l.released), sum((l) => l.paid)].map(plain)).toEqual([moved.earned, moved.released, moved.paid].map(plain));
    expect(Object.values(statement.period).map(plain)).toEqual(["400.00", "400.00", "400.00"]);
    expect(Object.values(statement.closing).map(plain)).toEqual(["1400.00", "1000.00", "1000.00"]);
    expect(plain(statement.lines.at(-1)!.balance)).toBe(plain(owedToThem(statement.closing)));
    expect(plain(waitingForCustomers(statement.closing))).toBe("400.00");
  });

  it("tells each event once, in order, with what is owed after it", () => {
    const statement = buildCommissionStatement(opening, november(), nameOf, formatAmount);
    expect(statement.lines.map((line) => [line.date, line.what, line.number, plain(line.earned), plain(line.released), plain(line.paid), plain(line.balance)])).toEqual([
      ["2026-11-03", "Earned on the sale", "SI-2627-00005", "500.00", "0.00", "0.00", "0.00"],
      ["2026-11-05", "Released: the customer paid (RC-2627-00007)", "SI-2627-00005", "0.00", "250.00", "0.00", "250.00"],
      ["2026-11-08", "Release taken back: the customer's payment was undone (RC-2627-00007)", "SI-2627-00005", "0.00", "-250.00", "0.00", "0.00"],
      ["2026-11-10", "Goods returned (CN-2627-00002)", "SI-2627-00005", "-100.00", "0.00", "0.00", "0.00"],
      ["2026-11-12", "Released: the customer paid (RC-2627-00009)", "SI-2627-00005", "0.00", "400.00", "0.00", "400.00"],
      ["2026-11-20", "Commission paid", "CP-2627-00001", "0.00", "0.00", "400.00", "0.00"],
    ]);
    expect(statement.lines[0]).toMatchObject({
      invoiceId: "si5",
      customerName: "Ahmed Traders",
      teamMember: null,
    });
    expect(statement.lines[5]).toMatchObject({
      invoiceId: null,
      customerName: null,
      teamMember: null,
    });
  });

  it("puts a movement dated earlier before one written before it", () => {
    const late = move({
      type: "accrued",
      amount: D(10),
      date: "2026-11-09",
      invoiceId: "si6",
      invoiceNumber: "SI-2627-00006",
    });
    const early = move({
      type: "accrued",
      amount: D(20),
      date: "2026-11-02",
      invoiceId: "si7",
      invoiceNumber: "SI-2627-00007",
    });
    const statement = buildCommissionStatement(noFigures(), [late, early], nameOf, formatAmount);
    expect(statement.lines.map((line) => line.number)).toEqual(["SI-2627-00007", "SI-2627-00006"]);
  });

  it("shows a payment that took back what was owed", () => {
    const part = buildCommissionStatement(
      noFigures(),
      [
        move({
          type: "paid",
          amount: D(300),
          date: "2026-11-20",
          sourceType: "commission_payment",
          sourceId: "cp2",
          sourceNumber: "CP-2627-00002",
        }),
        move({
          type: "recovery_recorded",
          amount: D(100),
          date: "2026-11-20",
          sourceType: "commission_payment",
          sourceId: "cp2",
          sourceNumber: "CP-2627-00002",
        }),
      ],
      nameOf,
      formatAmount,
    );
    expect(part.lines).toHaveLength(1);
    expect(part.lines[0]).toMatchObject({
      what: "Commission paid: 300.00 approved, less 100.00 owed back",
      number: "CP-2627-00002",
    });
    expect(plain(part.lines[0].paid)).toBe("200.00");

    const all = buildCommissionStatement(
      noFigures(),
      [
        move({
          type: "paid",
          amount: D(80),
          date: "2026-11-21",
          sourceType: "commission_payment",
          sourceId: "cp3",
          sourceNumber: "CP-2627-00003",
        }),
        move({
          type: "recovery_recorded",
          amount: D(80),
          date: "2026-11-21",
          sourceType: "commission_payment",
          sourceId: "cp3",
          sourceNumber: "CP-2627-00003",
        }),
      ],
      nameOf,
      formatAmount,
    );
    expect(all.lines[0].what).toBe("Commission of 80.00 set against what was owed back");
    expect(plain(all.lines[0].paid)).toBe("0.00");
  });

  it("names the team member and the manager's team rate on a manager's share", () => {
    const team = { kind: "team" as const, teamRate: D("0.5000") };
    const statement = buildCommissionStatement(
      noFigures(),
      [
        move({ ...team, type: "accrued", amount: D(6), date: "2026-11-03" }),
        move({ ...team, type: "accrued", amount: D(4), date: "2026-11-03" }),
        move({
          ...team,
          type: "released",
          amount: D(10),
          date: "2026-11-04",
          sourceType: "credit_note",
          sourceId: "cn3",
          sourceNumber: "CN-2627-00003",
        }),
        move({ type: "accrued", amount: D(50), date: "2026-11-03" }),
      ],
      nameOf,
      formatAmount,
    );
    expect(statement.lines.map((line) => [line.what, line.teamMember, plain(line.earned), plain(line.released)])).toEqual([
      ["Earned at the 0.5% team rate", "ali@example.test", "10.00", "0.00"],
      ["Earned on the sale", null, "50.00", "0.00"],
      ["Released: a credit note was set against the invoice (CN-2627-00003)", "ali@example.test", "0.00", "10.00"],
    ]);
  });

  it("is empty for a period with nothing in it, and carries the opening through", () => {
    const statement = buildCommissionStatement(opening, [], nameOf, formatAmount);
    expect(statement.lines).toEqual([]);
    expect(Object.values(statement.closing).map(plain)).toEqual(["1000.00", "600.00", "600.00"]);
  });
});

describe("figuresByPerson", () => {
  it("adds each person's movements up before and in the period", () => {
    const people = figuresByPerson([
      { userId: "ali", part: "opening", type: "accrued", amount: D(1000) },
      { userId: "ali", part: "opening", type: "released", amount: D(600) },
      { userId: "ali", part: "period", type: "accrued", amount: D(400) },
      { userId: "ali", part: "period", type: "paid", amount: D(500) },
      { userId: "imran", part: "period", type: "accrued", amount: D(10) },
      {
        userId: "imran",
        part: "period",
        type: "recovery_recorded",
        amount: D(5),
      },
    ]);
    const ali = people.find((p) => p.userId === "ali")!;
    expect(Object.values(ali.opening).map(plain)).toEqual(["1000.00", "600.00", "0.00"]);
    expect(Object.values(ali.period).map(plain)).toEqual(["400.00", "0.00", "500.00"]);
    expect(Object.values(ali.closing).map(plain)).toEqual(["1400.00", "600.00", "500.00"]);
    expect(Object.values(people.find((p) => p.userId === "imran")!.closing).map(plain)).toEqual(["10.00", "0.00", "-5.00"]);
  });
});

describe("statementFileName", () => {
  it("keeps letters, digits and dashes", () => {
    expect(statementFileName("ali.raza@example.test", "2026-11-01", "2026-11-30")).toBe("commission-ali-raza-2026-11-01-to-2026-11-30.pdf");
    expect(statementFileName("@@", "2026-11-01", "2026-11-30")).toBe("commission-commission-2026-11-01-to-2026-11-30.pdf");
  });
});

describe("monthChoices", () => {
  it("gives this month so far and the whole of last month", () => {
    expect(monthChoices("2026-11-15")).toEqual({
      thisMonth: { from: "2026-11-01", to: "2026-11-15" },
      lastMonth: { from: "2026-10-01", to: "2026-10-31" },
    });
    expect(monthChoices("2027-01-03").lastMonth).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(monthChoices("2028-03-01").lastMonth).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});
