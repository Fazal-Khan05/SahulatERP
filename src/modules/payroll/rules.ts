import Decimal from "decimal.js";
import { isIsoDate } from "@/modules/currencies/rules";
import { PROVINCES, type Province } from "@/modules/parties/rules";
import { inForceOn } from "@/modules/tax/rules";

// Step 40: employees, their pay, their attendance, and the dated statutory tables payroll reads
// (income tax on salary, EOBI, provincial social security, minimum wages). Pure rules: no
// database here. A rate is never typed into a command or screen: it comes from a dated row,
// found with inForceOn, and when none is in force the caller refuses to guess.

export { PROVINCES, type Province };

// ── Employees and their pay ─────────────────────────────────────────────────────────────────────

/** How an employee is paid: a monthly salary, or a wage for each day worked (the founder's decision, 2026-11-15). */
export const PAY_BASES = ["monthly", "daily"] as const;
export type PayBasis = (typeof PAY_BASES)[number];

/**
 * What a pay structure is made of. A monthly employee has basic pay and any allowances and
 * fixed deductions; a daily employee has a daily wage. Each is an amount a month, except the
 * daily wage, which is for one day.
 */
export const COMPONENTS = ["basic", "house_rent", "medical", "conveyance", "utilities", "other_allowance", "fixed_deduction", "daily_wage"] as const;
export type Component = (typeof COMPONENTS)[number];

export const COMPONENT_LABELS: Record<Component, string> = {
  basic: "Basic pay",
  house_rent: "House rent allowance",
  medical: "Medical allowance",
  conveyance: "Conveyance allowance",
  utilities: "Utilities allowance",
  other_allowance: "Other allowance",
  fixed_deduction: "Fixed deduction",
  daily_wage: "Daily wage",
};

/** The components each kind of employee may have. */
export const COMPONENTS_FOR: Record<PayBasis, readonly Component[]> = {
  monthly: ["basic", "house_rent", "medical", "conveyance", "utilities", "other_allowance", "fixed_deduction"],
  daily: ["daily_wage"],
};

export const isPayBasis = (value: unknown): value is PayBasis => typeof value === "string" && (PAY_BASES as readonly string[]).includes(value);
export const isComponent = (value: unknown): value is Component => typeof value === "string" && (COMPONENTS as readonly string[]).includes(value);
export const isProvince = (value: unknown): value is Province => typeof value === "string" && (PROVINCES as readonly string[]).includes(value);

/** One dated amount of one component: in force from its date until the next row of the same component. Nil ends it. */
export type PayRow = { component: Component; amount: Decimal; effectiveFrom: string };

/** What each component amounts to on a date: the latest row of each on or before it. Components at nil are left out. */
export function payOn(rows: readonly PayRow[], on: string): Map<Component, Decimal> {
  const pay = new Map<Component, Decimal>();
  for (const component of COMPONENTS) {
    const row = inForceOn(
      rows.filter((r) => r.component === component),
      on,
    );
    if (row && row.amount.gt(0)) pay.set(component, row.amount);
  }
  return pay;
}

// ── Income tax on salary ────────────────────────────────────────────────────────────────────────

/** One slab of the salaried individuals' table: on taxable income over `over` and up to `upTo` (null: no limit), `fixed` plus `rate` per cent of the amount over `over`. */
export type Slab = { over: Decimal; upTo: Decimal | null; fixed: Decimal; rate: Decimal };

const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * The year's income tax on a taxable salary, from the table in force: the slab the income falls
 * in (over its lower bound, and not over its upper one), its fixed amount, and its rate on what
 * is above the lower bound. Null when the slabs do not cover the income: a table with a gap is
 * refused, not guessed at.
 */
export function slabTax(annual: Decimal, slabs: readonly Slab[]): Decimal | null {
  if (annual.lte(0)) return new Decimal(0);
  const slab = slabs.find((s) => annual.gt(s.over) && (s.upTo === null || annual.lte(s.upTo)));
  if (!slab) return null;
  return paisa(slab.fixed.plus(annual.minus(slab.over).times(slab.rate).div(100)));
}

/** Why a table of slabs cannot be used, or null: it starts at nil, has no gaps or overlaps, ends without a limit, and each fixed amount is what the slabs below it come to. */
export function slabProblem(slabs: readonly Slab[]): string | null {
  if (slabs.length === 0) return "The table has no slabs.";
  const sorted = [...slabs].sort((a, b) => a.over.comparedTo(b.over));
  if (!sorted[0].over.isZero()) return "The first slab must start at nil.";
  for (const [index, slab] of sorted.entries()) {
    if (slab.rate.lt(0) || slab.rate.gt(100)) return `Slab ${index + 1}: the rate must be between 0 and 100 per cent.`;
    const next = sorted[index + 1];
    if (!next) {
      if (slab.upTo !== null) return "The last slab must have no upper limit.";
      break;
    }
    if (slab.upTo === null || !slab.upTo.eq(next.over)) return `Slab ${index + 1} must end where slab ${index + 2} starts.`;
    const reached = slab.fixed.plus(slab.upTo.minus(slab.over).times(slab.rate).div(100));
    if (!paisa(reached).eq(next.fixed)) return `Slab ${index + 2}: its fixed amount should be ${paisa(reached).toFixed(2)}, what the slabs below it come to.`;
  }
  return null;
}

/** The surcharge on the year's tax: so many per cent of it when taxable income is over the threshold (s.4AB). */
export function surcharge(annualIncome: Decimal, annualTax: Decimal, rule: { rate: Decimal; threshold: Decimal } | null): Decimal {
  if (!rule || !annualIncome.gt(rule.threshold)) return new Decimal(0);
  return paisa(annualTax.times(rule.rate).div(100));
}

/**
 * What of a month's pay is taxable as salary: everything paid, less the part of a medical
 * allowance the law exempts (up to `medicalExemptPercent` of basic pay, when the employer does
 * not also give free medical treatment). Fixed deductions are taken from pay, not from what is
 * taxable.
 */
export function taxableMonthlyPay(pay: ReadonlyMap<Component, Decimal>, medicalExemptPercent: Decimal | null): Decimal {
  let taxable = new Decimal(0);
  for (const [component, amount] of pay) {
    if (component === "fixed_deduction" || component === "daily_wage") continue;
    taxable = taxable.plus(amount);
  }
  const medical = pay.get("medical");
  if (medical && medicalExemptPercent) {
    const limit = (pay.get("basic") ?? new Decimal(0)).times(medicalExemptPercent).div(100);
    taxable = taxable.minus(Decimal.min(medical, limit));
  }
  return paisa(taxable);
}

/**
 * The tax for a month on a salary that is the same all year: the year's tax (with any surcharge)
 * on twelve months' taxable pay, divided by twelve. Step 41 adjusts for months that differ.
 */
export function monthlySalaryTax(
  monthlyTaxable: Decimal,
  slabs: readonly Slab[],
  surchargeRule: { rate: Decimal; threshold: Decimal } | null,
): { annualIncome: Decimal; annualTax: Decimal; monthly: Decimal } | null {
  const annualIncome = monthlyTaxable.times(12);
  const tax = slabTax(annualIncome, slabs);
  if (tax === null) return null;
  const annualTax = tax.plus(surcharge(annualIncome, tax, surchargeRule));
  return { annualIncome, annualTax, monthly: paisa(annualTax.div(12)) };
}

// ── Attendance ──────────────────────────────────────────────────────────────────────────────────

/** The month an attendance row is for, as its first day, YYYY-MM-01. */
export const isMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value) && isIsoDate(value);

/** How many days the month has. */
export function daysIn(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

/** Days as typed: a whole or half day, from 0 to the days in the month. */
export function parseDays(input: unknown, month: string): { ok: true; days: Decimal } | { ok: false; reason: string } {
  const typed = typeof input === "string" ? input.trim() : "";
  if (typed === "") return { ok: true, days: new Decimal(0) };
  if (!/^\d{1,2}(\.5|\.0)?$/.test(typed)) return { ok: false, reason: "Enter days as a whole number or a half, such as 2 or 1.5." };
  const days = new Decimal(typed);
  if (days.gt(daysIn(month))) return { ok: false, reason: `The month has ${daysIn(month)} days.` };
  return { ok: true, days };
}

/**
 * A monthly employee's pay for the month after unpaid days: each unpaid day takes off the month's
 * pay divided by the days in the month (the founder's decision, 2026-11-15). A daily employee is
 * paid the daily wage for each day worked.
 */
export function payForMonth(basis: PayBasis, monthlyOrDaily: Decimal, month: string, days: { worked: Decimal; unpaid: Decimal }): Decimal {
  if (basis === "daily") return paisa(monthlyOrDaily.times(days.worked));
  const perDay = monthlyOrDaily.div(daysIn(month));
  return paisa(monthlyOrDaily.minus(perDay.times(days.unpaid)));
}

/** How many days of a month someone was employed, from the day they joined to the day they left. */
export function daysEmployed(month: string, joinedOn: string, leftOn: string | null): number {
  const last = `${month.slice(0, 8)}${String(daysIn(month)).padStart(2, "0")}`;
  const from = joinedOn > month ? joinedOn : month;
  const to = leftOn !== null && leftOn < last ? leftOn : last;
  if (to < from) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

// ── The statutory tables ────────────────────────────────────────────────────────────────────────

/**
 * What a statutory row is for. A rate is a percentage; an amount is rupees a month (the
 * surcharge's amount is the yearly income above which it applies).
 */
export const STATUTORY_KINDS = ["minimum_wage", "eobi_wage", "eobi_employer", "eobi_employee", "social_security_employer", "medical_allowance_exempt", "salary_surcharge"] as const;
export type StatutoryKind = (typeof STATUTORY_KINDS)[number];
export const isStatutoryKind = (value: unknown): value is StatutoryKind => typeof value === "string" && (STATUTORY_KINDS as readonly string[]).includes(value);

export const STATUTORY_LABELS: Record<StatutoryKind, string> = {
  minimum_wage: "Minimum wage, a month",
  eobi_wage: "EOBI: the wage contributions are worked out on",
  eobi_employer: "EOBI: employer's share",
  eobi_employee: "EOBI: employee's share",
  social_security_employer: "Social security: employer's share",
  medical_allowance_exempt: "Medical allowance exempt, share of basic pay",
  salary_surcharge: "Surcharge on salary tax",
};

/** Which of a row's figures each kind has: a rate, an amount, or both (the surcharge: a rate above a yearly income). */
export const STATUTORY_SHAPE: Record<StatutoryKind, { rate: boolean; amount: boolean; byProvince: boolean }> = {
  minimum_wage: { rate: false, amount: true, byProvince: true },
  eobi_wage: { rate: false, amount: true, byProvince: false },
  eobi_employer: { rate: true, amount: false, byProvince: false },
  eobi_employee: { rate: true, amount: false, byProvince: false },
  social_security_employer: { rate: true, amount: false, byProvince: true },
  medical_allowance_exempt: { rate: true, amount: false, byProvince: false },
  salary_surcharge: { rate: true, amount: true, byProvince: false },
};

export type StatutoryRow = { kind: StatutoryKind; province: Province | null; rate: Decimal | null; amount: Decimal | null; effectiveFrom: string; legalReference: string };

/** The row of a kind in force on a date, for a province where the kind goes by province. Null when there is none: the caller refuses to guess. */
export function statutoryOn(rows: readonly StatutoryRow[], kind: StatutoryKind, on: string, province: Province | null = null): StatutoryRow | null {
  return inForceOn(
    rows.filter((row) => row.kind === kind && row.province === (STATUTORY_SHAPE[kind].byProvince ? province : null)),
    on,
  );
}

// ── What is typed ───────────────────────────────────────────────────────────────────────────────

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const tidy = (value: unknown) => text(value).replace(/\s+/g, " ");
const isTrue = (value: unknown) => value === true || value === "on" || value === "true";

export type RawEmployee = {
  code?: unknown;
  name?: unknown;
  designation?: unknown;
  cnic?: unknown;
  province?: unknown;
  branchId?: unknown;
  payBasis?: unknown;
  joinedOn?: unknown;
  leftOn?: unknown;
  eobi?: unknown;
  socialSecurity?: unknown;
  userId?: unknown;
};

export type EmployeeInput = {
  code: string;
  name: string;
  designation: string | null;
  cnic: string | null;
  province: Province;
  branchId: string | null;
  payBasis: PayBasis;
  joinedOn: string;
  leftOn: string | null;
  eobi: boolean;
  socialSecurity: boolean;
  userId: string | null;
};

/** Cleans what was typed for an employee, or gives the first thing that is wrong in plain words. */
export function readEmployee(raw: RawEmployee): { ok: true; employee: EmployeeInput } | { ok: false; reason: string } {
  const code = text(raw.code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/.test(code)) return { ok: false, reason: "Enter the employee's code: letters and numbers, up to 20, such as E-001." };
  const name = tidy(raw.name);
  if (name.length < 2 || name.length > 120) return { ok: false, reason: "Enter the employee's name." };
  const designation = tidy(raw.designation);
  if (designation.length > 80) return { ok: false, reason: "The designation: use at most 80 characters." };
  const cnic = text(raw.cnic).replace(/-/g, "");
  if (cnic !== "" && !/^[0-9]{13}$/.test(cnic)) return { ok: false, reason: "Enter the CNIC as 13 digits, with or without dashes, or leave it empty." };
  if (!isProvince(raw.province)) return { ok: false, reason: "Choose the province the employee works in." };
  if (!isPayBasis(raw.payBasis)) return { ok: false, reason: "Choose how the employee is paid: monthly, or by the day." };
  if (!isIsoDate(raw.joinedOn)) return { ok: false, reason: "Enter the day the employee joined." };
  const leftOn = text(raw.leftOn);
  if (leftOn !== "" && !isIsoDate(leftOn)) return { ok: false, reason: "Enter the day the employee left, or leave it empty." };
  if (leftOn !== "" && leftOn < raw.joinedOn) return { ok: false, reason: "The day the employee left cannot be before the day they joined." };
  const branchId = text(raw.branchId);
  const userId = text(raw.userId);
  return {
    ok: true,
    employee: {
      code,
      name,
      designation: designation === "" ? null : designation,
      cnic: cnic === "" ? null : cnic,
      province: raw.province,
      branchId: branchId === "" ? null : branchId,
      payBasis: raw.payBasis,
      joinedOn: raw.joinedOn,
      leftOn: leftOn === "" ? null : leftOn,
      eobi: isTrue(raw.eobi),
      socialSecurity: isTrue(raw.socialSecurity),
      userId: userId === "" ? null : userId,
    },
  };
}

/** An amount of rupees as typed: a plain number with at most two decimals. */
function readRupees(input: unknown): { ok: true; amount: Decimal } | { ok: false; reason: string } {
  const typed = text(input).replace(/,/g, "");
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(typed)) return { ok: false, reason: "Enter the amount in rupees, such as 45000 or 1250.50." };
  return { ok: true, amount: new Decimal(typed) };
}

export type RawPayChange = { component?: unknown; amount?: unknown; effectiveFrom?: unknown };

/** A change to one part of an employee's pay from a date. Nil ends that part. */
export function readPayChange(raw: RawPayChange, basis: PayBasis): { ok: true; change: PayRow } | { ok: false; reason: string } {
  if (!isComponent(raw.component) || !COMPONENTS_FOR[basis].includes(raw.component)) {
    return { ok: false, reason: basis === "daily" ? "A daily employee is paid a daily wage." : "Choose which part of the pay this is." };
  }
  const amount = readRupees(raw.amount);
  if (!amount.ok) return amount;
  if (!isIsoDate(raw.effectiveFrom)) return { ok: false, reason: "Enter the day the new amount starts." };
  return { ok: true, change: { component: raw.component, amount: amount.amount, effectiveFrom: raw.effectiveFrom } };
}

export type RawStatutoryRate = { kind?: unknown; province?: unknown; effectiveFrom?: unknown; rate?: unknown; amount?: unknown; legalReference?: unknown };

/** A statutory figure from a date, with the law or notification it comes from. */
export function readStatutoryRate(raw: RawStatutoryRate): { ok: true; row: StatutoryRow } | { ok: false; reason: string } {
  if (!isStatutoryKind(raw.kind)) return { ok: false, reason: "Choose what the figure is." };
  const shape = STATUTORY_SHAPE[raw.kind];
  let province: Province | null = null;
  if (shape.byProvince) {
    if (!isProvince(raw.province)) return { ok: false, reason: "Choose the province the figure is for." };
    province = raw.province;
  }
  if (!isIsoDate(raw.effectiveFrom)) return { ok: false, reason: "Enter the day the figure starts." };
  let rate: Decimal | null = null;
  if (shape.rate) {
    const typed = text(raw.rate);
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(typed) || new Decimal(typed).gt(100)) return { ok: false, reason: "Enter the rate as a percentage from 0 to 100, such as 5 or 1.5." };
    rate = new Decimal(typed);
  }
  let amount: Decimal | null = null;
  if (shape.amount) {
    const read = readRupees(raw.amount);
    if (!read.ok) return read;
    if (read.amount.lte(0)) return { ok: false, reason: "Enter an amount above nil." };
    amount = read.amount;
  }
  const legalReference = tidy(raw.legalReference);
  if (legalReference.length < 2 || legalReference.length > 200) return { ok: false, reason: "Say where the figure comes from: the Act and section, or the notification's number and date." };
  return { ok: true, row: { kind: raw.kind, province, effectiveFrom: raw.effectiveFrom, rate, amount, legalReference } };
}

// ── The attendance file ─────────────────────────────────────────────────────────────────────────

export const ATTENDANCE_COLUMNS = [
  { key: "code", header: "Code" },
  { key: "daysWorked", header: "Days worked" },
  { key: "unpaidDays", header: "Unpaid days" },
] as const;
export type AttendanceKey = (typeof ATTENDANCE_COLUMNS)[number]["key"];
export const ATTENDANCE_MAX_ROWS = 2000;

export type AttendanceLine = { row: number; code: string; daysWorked: Decimal; unpaidDays: Decimal; daysWorkedGiven: boolean };
export type AttendanceProblem = { row: number; name: string; problems: string[] };

/** The rows of an attendance file for a month, each cleaned, or every row with what is wrong in it. */
export function readAttendanceRows(rows: readonly { row: number; raw: Partial<Record<AttendanceKey, string>>; extra: boolean }[], month: string): { lines: AttendanceLine[]; problems: AttendanceProblem[] } {
  const lines: AttendanceLine[] = [];
  const problems: AttendanceProblem[] = [];
  const seen = new Set<string>();
  for (const { row, raw, extra } of rows) {
    const found: string[] = [];
    const code = text(raw.code);
    if (code === "") found.push("The code is empty.");
    else if (seen.has(code.toLowerCase())) found.push("This employee is in the file twice.");
    seen.add(code.toLowerCase());
    if (extra) found.push("The row has cells beyond the last column.");
    const worked = parseDays(raw.daysWorked, month);
    if (!worked.ok) found.push(`Days worked: ${worked.reason}`);
    const unpaid = parseDays(raw.unpaidDays, month);
    if (!unpaid.ok) found.push(`Unpaid days: ${unpaid.reason}`);
    if (worked.ok && unpaid.ok && worked.days.plus(unpaid.days).gt(daysIn(month))) found.push(`Days worked and unpaid days come to more than the month's ${daysIn(month)} days.`);
    if (found.length > 0 || !worked.ok || !unpaid.ok) problems.push({ row, name: code === "" ? "(no code)" : code, problems: found });
    else lines.push({ row, code, daysWorked: worked.days, unpaidDays: unpaid.days, daysWorkedGiven: text(raw.daysWorked) !== "" });
  }
  return { lines, problems };
}
