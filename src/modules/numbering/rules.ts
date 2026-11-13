import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for fiscal years, fiscal periods and document numbers. No I/O.
//
// A fiscal year is twelve monthly periods from the first day of a month. A company opens its
// first year from the month it chooses (July is usual in Pakistan) and each later year follows
// the last. A document's number is its type, its fiscal year and a counter that restarts each
// year: SI-2627-00001. The counter itself lives in the database and is handed out there, inside
// the transaction that writes the document; nothing here computes the next number.

/** The kinds of document that are numbered, with the letters that start their numbers. */
export const DOCUMENT_TYPES = {
  QT: "Quotation",
  SO: "Sales order",
  DN: "Delivery note",
  SI: "Sales invoice",
  CN: "Credit note",
  PO: "Purchase order",
  GR: "Goods received note",
  PB: "Supplier bill",
  DB: "Debit note",
  RC: "Receipt",
  PV: "Payment",
  JV: "Journal",
  ST: "Stock transfer",
  SA: "Stock adjustment",
  EX: "Expense",
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const isDocumentType = (value: unknown): value is DocumentType => typeof value === "string" && Object.hasOwn(DOCUMENT_TYPES, value);

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
/** The last day of a month, leap years included. */
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** True for the first day of a month written as YYYY-MM-DD. */
export function isMonthStart(value: unknown): value is string {
  return isIsoDate(value) && value.endsWith("-01");
}

/** The day after a date. */
export function nextDay(date: string): string {
  const [year, month, day] = parts(date);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return iso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** How a fiscal year is written: "2026-27" for a year from July 2026, "2026" for a calendar year. */
export function fiscalYearLabel(start: string): string {
  const [year, month] = parts(start);
  return month === 1 ? String(year) : `${year}-${pad((year + 1) % 100)}`;
}

/** The fiscal year as it appears inside a document number: "2627", or "2026" for a calendar year. */
export function fiscalYearCode(start: string): string {
  const [year, month] = parts(start);
  return month === 1 ? String(year) : `${pad(year % 100)}${pad((year + 1) % 100)}`;
}

export type Period = { periodNo: number; startsOn: string; endsOn: string };

/** The twelve monthly periods of the fiscal year that starts on `start`, the first of a month. */
export function monthlyPeriods(start: string): Period[] {
  const [startYear, startMonth] = parts(start);
  return Array.from({ length: 12 }, (_, index) => {
    const year = startYear + Math.floor((startMonth - 1 + index) / 12);
    const month = ((startMonth - 1 + index) % 12) + 1;
    return { periodNo: index + 1, startsOn: iso(year, month, 1), endsOn: iso(year, month, lastDay(year, month)) };
  });
}

/** The period a date falls in, or null when no open fiscal year covers it. */
export function periodFor<T extends { startsOn: string; endsOn: string }>(periods: readonly T[], date: string): T | null {
  return periods.find((period) => period.startsOn <= date && date <= period.endsOn) ?? null;
}

/** A document number: type, fiscal year, and the counter in at least five digits. */
export function formatDocumentNumber(type: DocumentType, yearCode: string, counter: number): string {
  return `${type}-${yearCode}-${pad(counter, 5)}`;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "July 2026" for a period that starts on 2026-07-01. */
export function periodName(startsOn: string): string {
  const [year, month] = parts(startsOn);
  return `${MONTHS[month - 1]} ${year}`;
}

/**
 * Whether a first fiscal year may start in this calendar year: from two years back to one year
 * ahead. The first year cannot be moved once opened, so a slip of the keyboard is refused.
 */
export function firstYearProblem(start: string, thisYear: number): string | null {
  const year = Number(start.slice(0, 4));
  return year < thisYear - 2 || year > thisYear + 1 ? `The first fiscal year must start between ${thisYear - 2} and ${thisYear + 1}.` : null;
}

/** The first day of a company's first fiscal year, from the month and year it chose. */
export function readFirstYear(raw: { month?: unknown; year?: unknown }): { ok: true; start: string } | { ok: false; reason: string } {
  const month = typeof raw.month === "string" && /^\d{1,2}$/.test(raw.month.trim()) ? Number(raw.month.trim()) : 0;
  const year = typeof raw.year === "string" && /^\d{4}$/.test(raw.year.trim()) ? Number(raw.year.trim()) : 0;
  if (month < 1 || month > 12) return { ok: false, reason: "Choose the month the fiscal year starts." };
  if (year < 2000 || year > 2100) return { ok: false, reason: "Enter the year the fiscal year starts, such as 2026." };
  return { ok: true, start: iso(year, month, 1) };
}
