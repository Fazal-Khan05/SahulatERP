import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { draftTotals, readDraft } from "./rules";

const row = (accountId: string, debit: string, credit: string, description = "") => ({ accountId, description, debit, credit });

describe("a manual journal as typed", () => {
  it("reads the date, the reason and the lines, skipping rows left empty", () => {
    const read = readDraft({ date: "2026-11-13", memo: "  Depreciation   for November ", branchId: "", lines: [row("a", "1500", "", " Vehicles "), row("", "", ""), row("b", "", "1500.50")] });
    expect(read.ok && { ...read.draft, lines: read.draft.lines.map((l) => `${l.accountId} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)} ${l.description}`) }).toEqual({
      date: "2026-11-13",
      memo: "Depreciation for November",
      branchId: null,
      lines: ["a 1500.00 0.00 Vehicles", "b 0.00 1500.50 null"],
    });
    // A draft may be unfinished: no lines at all, or lines that do not balance yet.
    expect(readDraft({ date: "2026-11-13", memo: "Started", lines: [] }).ok).toBe(true);
    expect(readDraft({ date: "2026-11-13", memo: "Started", branchId: " b1 " })).toMatchObject({ ok: true, draft: { branchId: "b1", lines: [] } });
  });

  it("says what is wrong, by line", () => {
    const bad = (raw: Parameters<typeof readDraft>[0]) => {
      const read = readDraft(raw);
      return read.ok ? null : read.reason;
    };
    expect(bad({ date: "13-11-2026", memo: "x" })).toBe("Enter the date of the journal.");
    expect(bad({ date: "2026-11-13", memo: "  " })).toBe("Say what the journal is for.");
    expect(bad({ date: "2026-11-13", memo: "x".repeat(501) })).toContain("at most 500 characters");
    const lines = (...rows: ReturnType<typeof row>[]) => bad({ date: "2026-11-13", memo: "x", lines: rows });
    expect(lines(row("a", "100", ""), row("", "", "100"))).toBe("Line 2: choose an account.");
    expect(lines(row("a", "100", "100"))).toBe("Line 1: enter a debit or a credit, not both.");
    expect(lines(row("a", "", ""), row("b", "", "5"))).toBe("Line 1: enter a debit or a credit.");
    expect(lines(row("a", "0", "0.00"))).toBe("Line 1: enter a debit or a credit.");
    expect(lines(row("a", "1,000", ""))).toBe("Line 1, debit: Enter the amount as a plain number without commas, such as 500000.");
    expect(lines(row("a", "", "-5"))).toContain("Line 1, credit:");
    expect(lines(row("a", "1.00001", ""))).toBe("Line 1, debit: Use at most 4 digits after the point.");
    expect(lines(row("a", "5", "", "d".repeat(301)))).toBe("Line 1: use at most 300 characters for the description.");
    // Lines are numbered as they will be kept: an empty row in between is not counted.
    expect(lines(row("a", "5", ""), row("", "", ""), row("", "5", ""))).toBe("Line 2: choose an account.");
    expect(bad({ date: "2026-11-13", memo: "x", lines: Array.from({ length: 201 }, () => row("a", "1", "")) })).toBe("A manual journal can have at most 200 lines.");
  });

  it("adds up debits and credits exactly and says what is missing", () => {
    const d = (value: string) => new Decimal(value);
    const totals = draftTotals([{ debit: d("0.1"), credit: d("0") }, { debit: d("0.2"), credit: d("0") }, { debit: d("0"), credit: d("0.25") }]);
    expect([totals.debit.toFixed(2), totals.credit.toFixed(2), totals.difference.toFixed(2)]).toEqual(["0.30", "0.25", "0.05"]);
    expect(draftTotals([]).difference.isZero()).toBe(true);
  });
});
