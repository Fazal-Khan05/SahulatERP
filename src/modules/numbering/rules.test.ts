import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPES, firstYearProblem, fiscalYearCode, fiscalYearLabel, formatDocumentNumber, isDocumentType, isMonthStart, monthlyPeriods, nextDay, periodFor, periodName, readFirstYear } from "./rules";

describe("fiscal years", () => {
  it("names a year by where it starts", () => {
    expect([fiscalYearLabel("2026-07-01"), fiscalYearCode("2026-07-01")]).toEqual(["2026-27", "2627"]);
    expect([fiscalYearLabel("2026-01-01"), fiscalYearCode("2026-01-01")]).toEqual(["2026", "2026"]);
    expect([fiscalYearLabel("2099-07-01"), fiscalYearCode("2099-07-01")]).toEqual(["2099-00", "9900"]);
    expect([fiscalYearLabel("2026-04-01"), fiscalYearCode("2026-04-01")]).toEqual(["2026-27", "2627"]);
  });

  it("cuts a year into twelve months, each from its first day to its last", () => {
    const periods = monthlyPeriods("2027-07-01");
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ periodNo: 1, startsOn: "2027-07-01", endsOn: "2027-07-31" });
    expect(periods[6]).toEqual({ periodNo: 7, startsOn: "2028-01-01", endsOn: "2028-01-31" });
    // February of a leap year has 29 days; the year ends the day before the next begins.
    expect(periods[7]).toEqual({ periodNo: 8, startsOn: "2028-02-01", endsOn: "2028-02-29" });
    expect(periods[11]).toEqual({ periodNo: 12, startsOn: "2028-06-01", endsOn: "2028-06-30" });
    expect(nextDay(periods[11].endsOn)).toBe("2028-07-01");
    // No day is in two periods or in none.
    for (let i = 1; i < 12; i++) expect(nextDay(periods[i - 1].endsOn)).toBe(periods[i].startsOn);
    expect(monthlyPeriods("2026-01-01")[11].endsOn).toBe("2026-12-31");
  });

  it("finds the period a date falls in", () => {
    const periods = monthlyPeriods("2026-07-01");
    expect(periodFor(periods, "2026-07-01")?.periodNo).toBe(1);
    expect(periodFor(periods, "2026-11-13")?.periodNo).toBe(5);
    expect(periodFor(periods, "2027-06-30")?.periodNo).toBe(12);
    expect(periodFor(periods, "2026-06-30")).toBeNull();
    expect(periodFor(periods, "2027-07-01")).toBeNull();
    expect(periodName("2026-11-01")).toBe("November 2026");
  });

  it("knows the first day of a month and the day after any day", () => {
    expect(isMonthStart("2026-07-01")).toBe(true);
    for (const bad of ["2026-07-02", "2026-13-01", "01-07-2026", "", null]) expect(isMonthStart(bad), String(bad)).toBe(false);
    expect([nextDay("2026-12-31"), nextDay("2028-02-28"), nextDay("2027-02-28")]).toEqual(["2027-01-01", "2028-02-29", "2027-03-01"]);
  });

  it("lets a first year start only near the present", () => {
    expect(firstYearProblem("2026-07-01", 2026)).toBeNull();
    expect(firstYearProblem("2024-01-01", 2026)).toBeNull();
    expect(firstYearProblem("2027-12-01", 2026)).toBeNull();
    expect(firstYearProblem("2023-07-01", 2026)).toBe("The first fiscal year must start between 2024 and 2027.");
    expect(firstYearProblem("2028-01-01", 2026)).toBe("The first fiscal year must start between 2024 and 2027.");
  });

  it("reads the month and year a company's first year starts", () => {
    expect(readFirstYear({ month: "7", year: "2026" })).toEqual({ ok: true, start: "2026-07-01" });
    expect(readFirstYear({ month: "1", year: "2027" })).toEqual({ ok: true, start: "2027-01-01" });
    expect(readFirstYear({ month: "13", year: "2026" })).toEqual({ ok: false, reason: "Choose the month the fiscal year starts." });
    expect(readFirstYear({ month: "7", year: "26" })).toEqual({ ok: false, reason: "Enter the year the fiscal year starts, such as 2026." });
    expect(readFirstYear({})).toEqual({ ok: false, reason: "Choose the month the fiscal year starts." });
  });
});

describe("document numbers", () => {
  it("are the type, the fiscal year and a counter of at least five digits", () => {
    expect(formatDocumentNumber("SI", "2627", 1)).toBe("SI-2627-00001");
    expect(formatDocumentNumber("PO", "2026", 42)).toBe("PO-2026-00042");
    expect(formatDocumentNumber("SI", "2627", 99999)).toBe("SI-2627-99999");
    expect(formatDocumentNumber("SI", "2627", 100000)).toBe("SI-2627-100000");
  });

  it("exist only for the kinds of document the product numbers", () => {
    expect(isDocumentType("SI")).toBe(true);
    for (const bad of ["si", "XX", "toString", "", null, 5]) expect(isDocumentType(bad), String(bad)).toBe(false);
    expect(Object.keys(DOCUMENT_TYPES).every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(new Set(Object.values(DOCUMENT_TYPES)).size).toBe(Object.keys(DOCUMENT_TYPES).length);
  });
});
