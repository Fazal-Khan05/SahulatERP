import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  currencyCodeSchema,
  currencyNameSchema,
  formatIsoDate,
  formatRate,
  isIsoDate,
  parseRate,
  rateInForce,
  rateSourceSchema,
} from "./rules";

describe("currency input", () => {
  it("accepts a three-letter code in any case and stores it in capitals", () => {
    expect(currencyCodeSchema.parse(" usd ")).toBe("USD");
    for (const bad of ["US", "USDT", "U$D", "12A", ""]) expect(currencyCodeSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("requires a name and a source", () => {
    expect(currencyNameSchema.parse("  US Dollar ")).toBe("US Dollar");
    expect(currencyNameSchema.safeParse("x").success).toBe(false);
    expect(rateSourceSchema.parse(" Bank counter rate ")).toBe("Bank counter rate");
    expect(rateSourceSchema.safeParse("   ").success).toBe(false);
  });

  it("knows a real calendar date", () => {
    expect(isIsoDate("2026-11-12")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "12-11-2026", "2026-1-5", "", null, 20261112]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});

describe("parseRate", () => {
  it("reads a plain number exactly, as a decimal", () => {
    const parsed = parseRate(" 278.50 ");
    expect(parsed.ok && parsed.rate.equals("278.5")).toBe(true);
    const fine = parseRate("0.00000001");
    expect(fine.ok && fine.rate.toFixed()).toBe("0.00000001");
    // A value a JS number cannot hold exactly stays exact.
    const exact = parseRate("0.1");
    expect(exact.ok && exact.rate.plus("0.2").toFixed()).toBe("0.3");
  });

  it.each([
    ["", "Enter the rate."],
    ["abc", "Enter the rate as a plain number, such as 278.5."],
    ["1,234.5", "Enter the rate as a plain number, such as 278.5."],
    ["-5", "Enter the rate as a plain number, such as 278.5."],
    ["1e3", "Enter the rate as a plain number, such as 278.5."],
    [".5", "Enter the rate as a plain number, such as 278.5."],
    ["0", "The rate must be more than zero."],
    ["0.000", "The rate must be more than zero."],
    ["1.123456789", "Use at most 8 digits after the point."],
    ["1234567890123", "That rate is too large."],
  ])("refuses %j", (input, reason) => {
    expect(parseRate(input)).toEqual({ ok: false, reason });
  });

  it("refuses anything that is not text", () => {
    expect(parseRate(278.5)).toEqual({ ok: false, reason: "Enter the rate." });
    expect(parseRate(null)).toEqual({ ok: false, reason: "Enter the rate." });
  });
});

describe("rateInForce", () => {
  const rates = [
    { date: "2026-11-10", rate: "279.10" },
    { date: "2026-10-01", rate: "277.00" },
    { date: "2026-11-01", rate: "278.50" },
  ];

  it("returns the rate dated on the day itself", () => {
    expect(rateInForce(rates, "2026-11-01")?.rate).toBe("278.50");
  });

  it("returns the latest rate before the day when there is none on it", () => {
    expect(rateInForce(rates, "2026-11-09")?.rate).toBe("278.50");
    expect(rateInForce(rates, "2026-10-31")?.rate).toBe("277.00");
  });

  it("returns the newest rate for any later day", () => {
    expect(rateInForce(rates, "2027-06-30")?.rate).toBe("279.10");
  });

  it("returns nothing for a day before the first rate, or when there are no rates", () => {
    expect(rateInForce(rates, "2026-09-30")).toBeNull();
    expect(rateInForce([], "2026-11-01")).toBeNull();
  });

  it("never uses a rate dated after the day", () => {
    expect(rateInForce([{ date: "2026-11-02", rate: "1" }], "2026-11-01")).toBeNull();
  });
});

describe("formatting", () => {
  it("shows a rate without an exponent or trailing zeros, with at least two decimals", () => {
    expect(formatRate(new Decimal("278.5"))).toBe("278.50");
    expect(formatRate(new Decimal("278"))).toBe("278.00");
    expect(formatRate(new Decimal("0.00000123"))).toBe("0.00000123");
    expect(formatRate(new Decimal("3.67250000"))).toBe("3.6725");
  });

  it("shows a date as day, month, year", () => {
    expect(formatIsoDate("2026-11-12")).toBe("12-11-2026");
  });
});
