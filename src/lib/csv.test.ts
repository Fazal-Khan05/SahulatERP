import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { formatAmount, parseAmount } from "./money";

const rows = (text: string) => {
  const parsed = parseCsv(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.rows;
};

describe("parseCsv", () => {
  it("reads rows and cells, whatever the line ending", () => {
    expect(rows("Name,City\nAli Traders,Lahore\n")).toEqual([
      ["Name", "City"],
      ["Ali Traders", "Lahore"],
    ]);
    expect(rows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(rows("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops the byte-order mark Excel writes and keeps an empty line as an empty row", () => {
    // Kept, so the third row of the file is still the third row here.
    expect(rows("\ufeffName\n\nAli\n\n")).toEqual([["Name"], [""], ["Ali"], [""]]);
  });

  it("keeps commas, quotes and line breaks inside a quoted cell", () => {
    expect(rows('Name,Address\n"Khan, Sons & Co","12 ""A"" Road\nLahore"\n')).toEqual([
      ["Name", "Address"],
      ["Khan, Sons & Co", '12 "A" Road\nLahore'],
    ]);
  });

  it("keeps empty cells, cells as written, and a row of only commas", () => {
    expect(rows("a,,c\n, b ,\n,,\n")).toEqual([
      ["a", "", "c"],
      ["", " b ", ""],
      ["", "", ""],
    ]);
  });

  it("refuses a quote that never closes, or text after a closing quote", () => {
    expect(parseCsv('Name\n"Ali\nTraders')).toEqual({ ok: false, reason: "A quote opened on line 2 is never closed." });
    expect(parseCsv('Name\n"Ali" Traders\n')).toEqual({
      ok: false,
      reason: "Line 2 has text after a closing quote. Check the quotes in that line.",
    });
  });

  it("reads nothing from nothing", () => {
    expect(rows("")).toEqual([]);
    expect(rows("Name")).toEqual([["Name"]]);
    expect(rows("Name\n")).toEqual([["Name"]]);
  });
});

describe("amounts", () => {
  it("reads a plain number exactly", () => {
    const parsed = parseAmount(" 500000.50 ");
    expect(parsed.ok && parsed.amount.toFixed(4)).toBe("500000.5000");
    const zero = parseAmount("0");
    expect(zero.ok && zero.amount.isZero()).toBe(true);
    // A value a JS number cannot hold exactly stays exact.
    const exact = parseAmount("0.1");
    expect(exact.ok && exact.amount.plus("0.2").toFixed()).toBe("0.3");
  });

  it.each([
    ["", "Enter the amount."],
    ["5,00,000", "Enter the amount as a plain number without commas, such as 500000."],
    ["-5", "Enter the amount as a plain number without commas, such as 500000."],
    ["1e6", "Enter the amount as a plain number without commas, such as 500000."],
    ["Rs 500", "Enter the amount as a plain number without commas, such as 500000."],
    ["1.12345", "Use at most 4 digits after the point."],
    ["1234567890123456", "That amount is too large."],
  ])("refuses %j", (input, reason) => {
    expect(parseAmount(input)).toEqual({ ok: false, reason });
  });

  it("refuses anything that is not text", () => {
    expect(parseAmount(500000)).toEqual({ ok: false, reason: "Enter the amount." });
  });

  it("groups the Pakistani way: three digits, then twos", () => {
    const shown = (value: string) => formatAmount(new Decimal(value));
    expect(shown("0")).toBe("0.00");
    expect(shown("999")).toBe("999.00");
    expect(shown("1000")).toBe("1,000.00");
    expect(shown("100000")).toBe("1,00,000.00");
    expect(shown("1234567.5")).toBe("12,34,567.50");
    expect(shown("123456789.1234")).toBe("12,34,56,789.1234");
    expect(shown("-2500")).toBe("-2,500.00");
  });
});
