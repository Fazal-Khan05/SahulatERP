import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ageOpenItems, ageingTable, buildStatement, overdueCustomers, promiseState, readFollowUp, readPeriod, readPromise } from "./rules";

const d = (value: string | number) => new Decimal(value);
const TODAY = "2026-11-15";
const who = (name: string) => ({ customerId: name, code: null, name });

describe("ageing what customers owe", () => {
  it("puts each outstanding amount in the band of its days past due", () => {
    const aged = ageOpenItems(
      who("Khan Autos"),
      [
        { dueDate: "2026-11-30", outstanding: d(100) }, // not due
        { dueDate: "2026-11-15", outstanding: d(50) }, // due today: not overdue
        { dueDate: "2026-11-14", outstanding: d(10) }, // 1 day
        { dueDate: "2026-10-16", outstanding: d(20) }, // 30 days
        { dueDate: "2026-10-15", outstanding: d(30) }, // 31 days
        { dueDate: "2026-08-17", outstanding: d(40) }, // 90 days
        { dueDate: "2026-08-16", outstanding: d(60) }, // 91 days
        { dueDate: "2026-01-01", outstanding: d(0) }, // paid: ignored
      ],
      TODAY,
    );
    expect(aged.bands.map((band) => band.toFixed())).toEqual(["150", "30", "30", "40", "60"]);
    expect(aged.total.toFixed()).toBe("310");
    expect(aged.overdue.toFixed()).toBe("160");
    expect(aged.oldestDays).toBe(91);
  });

  it("lists as overdue only customers with something past due, most overdue first, and ages every customer who owes", () => {
    const rows = [
      ageOpenItems(who("A"), [{ dueDate: "2026-12-01", outstanding: d(500) }], TODAY),
      ageOpenItems(who("B"), [{ dueDate: "2026-11-01", outstanding: d(200) }], TODAY),
      ageOpenItems(who("C"), [{ dueDate: "2026-09-01", outstanding: d(300) }], TODAY),
      ageOpenItems(who("D"), [], TODAY),
    ];
    expect(overdueCustomers(rows).map((row) => row.name)).toEqual(["C", "B"]);
    const table = ageingTable(rows, TODAY);
    expect(table.rows.map((row) => row.cells[1])).toEqual(["A", "B", "C", "Total"]);
    expect(table.rows.at(-1)!.cells.slice(2).map((cell) => (cell as Decimal).toFixed())).toEqual(["500", "200", "0", "300", "0", "1000"]);
    // The overdue list's total is the ageing report's overdue bands, by construction.
    const overdueTotal = overdueCustomers(rows).reduce((total, row) => total.plus(row.overdue), d(0));
    const bands = table.rows.at(-1)!.cells.slice(3, 7) as Decimal[];
    expect(overdueTotal.eq(bands.reduce((total, band) => total.plus(band), d(0)))).toBe(true);
  });
});

describe("promises to pay", () => {
  const promise = { amount: d(5000), promisedOn: "2026-11-20" };
  it("is kept when the amount has arrived, even early", () => {
    expect(promiseState(promise, d(5000), "2026-11-16")).toBe("kept");
    expect(promiseState(promise, d(6000), "2026-12-01")).toBe("kept");
  });
  it("waits until the day has passed, then is broken if less arrived", () => {
    expect(promiseState(promise, d(4999.99), "2026-11-20")).toBe("waiting");
    expect(promiseState(promise, d(4999.99), "2026-11-21")).toBe("broken");
    expect(promiseState(promise, d(0), "2026-11-21")).toBe("broken");
  });
  it("reads what was typed", () => {
    expect(readPromise({ amount: "5000", promisedOn: "2026-11-20", note: " by cheque " }, TODAY)).toEqual({ ok: true, draft: { amount: d(5000), promisedOn: "2026-11-20", note: "by cheque" } });
    expect(readPromise({ amount: "0", promisedOn: "2026-11-20" }, TODAY)).toEqual({ ok: false, reason: "The amount promised must be more than nothing." });
    expect(readPromise({ amount: "10.555", promisedOn: "2026-11-20" }, TODAY)).toMatchObject({ ok: false });
    expect(readPromise({ amount: "5,000", promisedOn: "2026-11-20" }, TODAY)).toMatchObject({ ok: false });
    expect(readPromise({ amount: "5000", promisedOn: "2026-11-14" }, TODAY)).toEqual({ ok: false, reason: "A promise is for today or a day to come." });
  });
});

describe("follow-ups", () => {
  it("needs a note, and a next day that is not in the past", () => {
    expect(readFollowUp({ note: "Said he will pay on Friday", nextOn: "2026-11-20" }, TODAY)).toEqual({ ok: true, draft: { note: "Said he will pay on Friday", nextOn: "2026-11-20" } });
    expect(readFollowUp({ note: "No answer", nextOn: "" }, TODAY)).toEqual({ ok: true, draft: { note: "No answer", nextOn: null } });
    expect(readFollowUp({ note: "  " }, TODAY)).toEqual({ ok: false, reason: "Write what was said." });
    expect(readFollowUp({ note: "x", nextOn: "2026-11-14" }, TODAY)).toEqual({ ok: false, reason: "The next follow-up cannot be in the past." });
  });
});

describe("the customer statement", () => {
  it("runs a balance from what was owed before the period", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 9, minute));
    const statement = buildStatement({ debit: d(1000), credit: d(0) }, [
      { date: "2026-11-05", writtenAt: at(2), sourceType: "receipt", number: "RC-2627-00001", debit: d(0), credit: d(1500) },
      { date: "2026-11-03", writtenAt: at(1), sourceType: "sales_invoice", number: "SI-2627-00001", debit: d(2000), credit: d(0) },
      { date: "2026-11-05", writtenAt: at(3), sourceType: "cheque_return", number: "RC-2627-00001", debit: d(1500), credit: d(0) },
    ]);
    expect(statement.rows.map((row) => `${row.what} ${row.balance.toFixed()}`)).toEqual(["Invoice 3000", "Received 1500", "Cheque returned 3000"]);
    // A cheque that bounced before clearing reverses its receipt's entry.
    const reversed = buildStatement({ debit: d(0), credit: d(0) }, [{ date: "2026-11-06", writtenAt: at(4), sourceType: "reversal", number: null, debit: d(1500), credit: d(0) }]);
    expect(reversed.rows[0].what).toBe("Receipt taken back");
    expect(statement.closing.toFixed()).toBe("3000");
    expect(`${statement.debits.toFixed()} ${statement.credits.toFixed()}`).toBe("3500 1500");
    // Paid ahead: the opening is a credit.
    expect(buildStatement({ debit: d(0), credit: d(250) }, []).closing.toFixed()).toBe("-250");
  });

  it("reads the period, this month to date by default", () => {
    expect(readPeriod({}, TODAY)).toEqual({ from: "2026-11-01", to: TODAY });
    expect(readPeriod({ from: "2026-12-01", to: "2026-11-10" }, TODAY)).toEqual({ from: "2026-11-10", to: "2026-11-10" });
  });
});
