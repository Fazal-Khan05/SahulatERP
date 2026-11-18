import Decimal from "decimal.js";
import {
  COMPONENT_LABELS,
  daysEmployed,
  daysIn,
  monthlySalaryTax,
  payOn,
  slabTax,
  statutoryOn,
  surcharge,
  taxableMonthlyPay,
  type Component,
  type PayBasis,
  type PayRow,
  type Province,
  type Slab,
  type StatutoryRow,
} from "@/modules/payroll/rules";

// Step 41: a month's payslip, worked out from Step 40's pay, attendance and statutory tables,
// and the commission approved for the person. Pure rules: no database here. A rate is never
// typed: each comes from a dated row in force in the month, and when none is, the payslip is
// refused with the reason, never guessed at.

const NIL = new Decimal(0);
const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const sum = (amounts: readonly Decimal[]) => amounts.reduce((total, amount) => total.plus(amount), NIL);

export const RUN_STATUSES = ["draft", "reviewed", "approved", "paid", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: "Draft",
  reviewed: "Reviewed",
  approved: "Approved",
  paid: "Paid",
  cancelled: "Cancelled",
};

/** The month's last day. */
export function monthEnd(month: string): string {
  return `${month.slice(0, 8)}${String(daysIn(month)).padStart(2, "0")}`;
}

/** The first day of the tax year (July to June) a month is in. */
export function taxYearStart(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return `${number >= 7 ? year : year - 1}-07-01`;
}

/** How many months of the tax year are left, this one included: twelve in July, one in June. */
export function monthsLeftInTaxYear(month: string): number {
  const number = Number(month.slice(5, 7));
  return 12 - ((number - 7 + 12) % 12);
}

/** The first day of the month a date is in. */
export function monthOf(isoDate: string): string {
  return `${isoDate.slice(0, 8)}01`;
}

/** How many months of the tax year come before this one in which someone who joined on a day was employed. */
export function monthsEmployedEarlier(month: string, joinedOn: string): number {
  const start = taxYearStart(month);
  const from = monthOf(joinedOn) > start ? monthOf(joinedOn) : start;
  const count = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
  return Math.max(0, count(month) - count(from));
}

// ── Commission ──────────────────────────────────────────────────────────────────────────────────

/**
 * The commission a person's payslip carries, as the database gives it
 * (app.payroll_commission_basis), as at the run's date: the approved commission released and
 * unpaid, and what is owed back, in all, with a fingerprint of the accrual-by-accrual figures. Kept
 * on the payslip as given: approval asks again and refuses the run if anything differs. Nothing
 * ({}) for someone with no login.
 */
export type CommissionBasis = { gross?: string; owed?: string; digest?: string };

export const NO_COMMISSION: CommissionBasis = {};

/** What the basis comes to: the approved commission, what is owed back from it, and the rest, which is paid. As app.pay_commission settles it. */
export function commissionOf(basis: CommissionBasis): { gross: Decimal; owed: Decimal; recovered: Decimal; paid: Decimal } {
  const gross = new Decimal(basis.gross ?? "0");
  const owed = new Decimal(basis.owed ?? "0");
  const recovered = Decimal.min(gross, owed);
  return { gross, owed, recovered, paid: gross.minus(recovered) };
}

// ── The payslip ─────────────────────────────────────────────────────────────────────────────────

export type LineKind = "earning" | "deduction" | "employer";
export type PayslipLine = { kind: LineKind; code: string; label: string; amount: Decimal; loanId?: string };

/** A loan to the person still owed on, oldest first (Step 42): what comes off each month, and what is left. */
export type OpenLoan = { id: string; number: string; instalment: Decimal; owed: Decimal };

export type PayslipEmployee = {
  id: string;
  code: string;
  name: string;
  payBasis: PayBasis;
  province: Province;
  joinedOn: string;
  leftOn: string | null;
  eobi: boolean;
  socialSecurity: boolean;
  userId: string | null;
};

export type PayslipInput = {
  month: string;
  employee: PayslipEmployee;
  pay: readonly PayRow[];
  /** The month's attendance, if any was entered. */
  attendance: { daysWorked: Decimal; unpaidDays: Decimal } | null;
  slabs: { from: string; slabs: readonly Slab[] } | null;
  rates: readonly StatutoryRow[];
  /** The commission due to the person's login; NO_COMMISSION for someone with no login. */
  commission: CommissionBasis;
  /** Their loans still owed on (Step 42); none when left out. */
  loans?: readonly OpenLoan[];
  /** What their approved payslips earlier in the tax year came to: taxable pay, the tax deducted from it, and how many months they cover. */
  before: { taxable: Decimal; tax: Decimal; months: number };
};

export type Payslip = {
  employeeId: string;
  userId: string | null;
  payBasis: PayBasis;
  daysInMonth: number;
  daysEmployed: number;
  /** The days paid for: worked, for a daily employee; employed less unpaid days, for a monthly one. */
  daysWorked: Decimal;
  unpaidDays: Decimal;
  earnings: Decimal;
  commission: Decimal;
  commissionRecovered: Decimal;
  taxable: Decimal;
  tax: Decimal;
  eobiEmployee: Decimal;
  deductions: Decimal;
  /** Of the deductions, what comes back on loans (Step 42). */
  loanRecovery: Decimal;
  net: Decimal;
  employerEobi: Decimal;
  employerSocialSecurity: Decimal;
  taxableBefore: Decimal;
  taxBefore: Decimal;
  /** How many months of the tax year before this one had an approved payslip: what taxableBefore and taxBefore add up. */
  monthsBefore: number;
  /** Months of the tax year before this one in which they were employed and nothing was run here, and their pay and tax, assumed. */
  assumedMonths: number;
  assumedTaxable: Decimal;
  assumedTax: Decimal;
  monthsLeft: number;
  annualTaxable: Decimal;
  annualTax: Decimal;
  commissionBasis: CommissionBasis;
  lines: PayslipLine[];
};

const EARNINGS: readonly Component[] = ["basic", "house_rent", "medical", "conveyance", "utilities", "other_allowance"];

/**
 * One person's payslip for a month.
 *
 * Pay: the pay in force on the last day they were employed in the month. A monthly employee is
 * paid each part of it for the days employed less unpaid days, over the days in the month (a full
 * month with no unpaid days is the whole of it); a daily employee the daily wage for each day
 * worked. Commission: what is approved and released, less what they owe back.
 *
 * Income tax, s.149: the year's taxable salary is what they were paid earlier in the tax year,
 * this month's, and this month's regular pay for each month left after it (none when they leave
 * this month); the year's tax on that (with any surcharge), less the tax already deducted, is
 * spread over the months left, this one included. Commission is counted once, in the month paid.
 * Earlier months of the tax year in which they were employed and no run was approved here (a
 * company that starts its payroll here partway through the year) are taken as paid their regular
 * pay and taxed evenly on it, as Step 40 shows the tax on a pay.
 *
 * EOBI: the employee's and the employer's shares of the wage EOBI is worked out on, for someone
 * registered. Social security: the employer's share of the province's minimum wage, for someone
 * registered. The fixed deduction is taken whole.
 *
 * Nothing taken from pay takes it below nil: tax first, then EOBI, then the fixed deduction, as
 * far as the pay goes. Tax not deducted this month is deducted over the months after it.
 */
export function workOutPayslip(input: PayslipInput): { ok: true; payslip: Payslip } | { ok: false; reason: string } {
  const { month, employee } = input;
  const dim = daysIn(month);
  const employed = daysEmployed(month, employee.joinedOn, employee.leftOn);
  if (employed <= 0) return { ok: false, reason: "was not employed in this month." };
  const last = monthEnd(month);
  const lastEmployed = employee.leftOn !== null && employee.leftOn < last ? employee.leftOn : last;
  const pay = payOn(input.pay, lastEmployed);
  const lines: PayslipLine[] = [];

  // ── Pay for the days ──
  let daysWorked: Decimal;
  let unpaidDays = NIL;
  let taxableMonth: Decimal;
  let regularMonthly: Decimal;
  if (employee.payBasis === "daily") {
    const wage = pay.get("daily_wage");
    if (!wage) return { ok: false, reason: "has no daily wage on record for this month." };
    daysWorked = input.attendance?.daysWorked ?? NIL;
    if (daysWorked.gt(employed)) return { ok: false, reason: `has ${daysWorked.toFixed()} days worked, more than the ${employed} days employed in the month.` };
    const amount = paisa(wage.times(daysWorked));
    if (amount.gt(0)) lines.push({ kind: "earning", code: "daily_wage", label: `Daily wage, ${daysWorked.toFixed()} days`, amount });
    taxableMonth = amount;
    regularMonthly = amount;
  } else {
    if (!EARNINGS.some((component) => pay.has(component))) return { ok: false, reason: "has no pay on record for this month." };
    unpaidDays = input.attendance?.unpaidDays ?? NIL;
    daysWorked = new Decimal(employed).minus(unpaidDays);
    if (daysWorked.lt(0)) return { ok: false, reason: `has ${unpaidDays.toFixed()} unpaid days, more than the ${employed} days employed in the month.` };
    const share = daysWorked.div(dim);
    const prorated = new Map<Component, Decimal>();
    for (const component of EARNINGS) {
      const full = pay.get(component);
      if (!full) continue;
      const amount = daysWorked.eq(dim) ? full : paisa(full.times(share));
      prorated.set(component, amount);
      if (amount.gt(0)) lines.push({ kind: "earning", code: component, label: COMPONENT_LABELS[component], amount });
    }
    const exempt = statutoryOn(input.rates, "medical_allowance_exempt", last)?.rate ?? null;
    taxableMonth = taxableMonthlyPay(prorated, exempt);
    regularMonthly = taxableMonthlyPay(pay, exempt);
  }
  const earnings = sum(lines.map((line) => line.amount));

  // ── Commission ──
  const commission = commissionOf(input.commission);
  if (commission.paid.gt(0)) {
    lines.push({
      kind: "earning",
      code: "commission",
      label: commission.recovered.gt(0) ? `Commission, less ${commission.recovered.toFixed(2)} owed back` : "Commission",
      amount: commission.paid,
    });
  }
  taxableMonth = taxableMonth.plus(commission.paid);

  // ── Income tax ──
  const monthsLeft = monthsLeftInTaxYear(month);
  const leaving = employee.leftOn !== null && employee.leftOn <= last;
  const monthsAfter = leaving ? 0 : monthsLeft - 1;
  if (!input.slabs) return { ok: false, reason: "cannot be taxed: there is no salary tax table in force in this month." };
  const surchargeRow = statutoryOn(input.rates, "salary_surcharge", last);
  const surchargeRule = surchargeRow?.rate && surchargeRow.amount ? { rate: surchargeRow.rate, threshold: surchargeRow.amount } : null;
  const assumedMonths = Math.max(0, monthsEmployedEarlier(month, employee.joinedOn) - input.before.months);
  const even = assumedMonths > 0 ? monthlySalaryTax(regularMonthly, input.slabs.slabs, surchargeRule) : null;
  if (assumedMonths > 0 && even === null) return { ok: false, reason: "cannot be taxed: the salary tax table in force has a gap." };
  const assumedTaxable = regularMonthly.times(assumedMonths);
  const assumedTax = even ? even.monthly.times(assumedMonths) : NIL;
  const annualTaxable = input.before.taxable.plus(assumedTaxable).plus(taxableMonth).plus(regularMonthly.times(monthsAfter));
  const yearTax = slabTax(annualTaxable, input.slabs.slabs);
  if (yearTax === null) return { ok: false, reason: "cannot be taxed: the salary tax table in force has a gap." };
  const annualTax = yearTax.plus(surcharge(annualTaxable, yearTax, surchargeRule));
  const taxDue = paisa(Decimal.max(NIL, annualTax.minus(input.before.tax).minus(assumedTax).div(monthsAfter + 1)));

  // ── EOBI and social security ──
  let eobiDue = NIL;
  let employerEobi = NIL;
  if (employee.eobi) {
    const wage = statutoryOn(input.rates, "eobi_wage", last)?.amount;
    const own = statutoryOn(input.rates, "eobi_employee", last)?.rate;
    const employer = statutoryOn(input.rates, "eobi_employer", last)?.rate;
    if (!wage || !own || !employer) return { ok: false, reason: "is registered with EOBI, and the EOBI wage or shares in force in this month are missing." };
    eobiDue = paisa(wage.times(own).div(100));
    employerEobi = paisa(wage.times(employer).div(100));
  }
  let employerSocialSecurity = NIL;
  if (employee.socialSecurity) {
    const rate = statutoryOn(input.rates, "social_security_employer", last, employee.province)?.rate;
    const wage = statutoryOn(input.rates, "minimum_wage", last, employee.province)?.amount;
    if (!rate || !wage) return { ok: false, reason: "is registered for social security, and the province's minimum wage or share in force in this month is missing." };
    employerSocialSecurity = paisa(wage.times(rate).div(100));
  }

  // ── What is taken, as far as the pay goes ──
  let left = earnings.plus(commission.paid);
  const tax = Decimal.min(taxDue, left);
  left = left.minus(tax);
  const eobiEmployee = Decimal.min(eobiDue, left);
  left = left.minus(eobiEmployee);
  const fixed = employee.payBasis === "monthly" ? (pay.get("fixed_deduction") ?? NIL) : NIL;
  const fixedTaken = Decimal.min(fixed, left);
  left = left.minus(fixedTaken);
  // Loans last, oldest first: each month's instalment, or all that is owed when they leave this
  // month (final settlement), as far as the pay goes. What the pay cannot cover stays owed.
  const loanLines: PayslipLine[] = [];
  for (const loan of input.loans ?? []) {
    const due = Decimal.min(leaving ? loan.owed : loan.instalment, loan.owed);
    const take = Decimal.min(due, left);
    if (take.lte(0)) continue;
    loanLines.push({ kind: "deduction", code: "loan", label: take.lt(due) ? `Loan ${loan.number}, ${take.toFixed(2)} of ${due.toFixed(2)}` : `Loan ${loan.number}`, amount: take, loanId: loan.id });
    left = left.minus(take);
  }
  const loanRecovery = loanLines.reduce((t, line) => t.plus(line.amount), NIL);
  const deductions = fixedTaken.plus(loanRecovery);

  if (tax.gt(0)) lines.push({ kind: "deduction", code: "income_tax", label: "Income tax (s.149)", amount: tax });
  if (eobiEmployee.gt(0)) lines.push({ kind: "deduction", code: "eobi_employee", label: "EOBI, employee's share", amount: eobiEmployee });
  if (fixedTaken.gt(0)) {
    lines.push({ kind: "deduction", code: "fixed_deduction", label: fixedTaken.lt(fixed) ? `Fixed deduction, ${fixedTaken.toFixed(2)} of ${fixed.toFixed(2)}` : "Fixed deduction", amount: fixedTaken });
  }
  lines.push(...loanLines);
  if (employerEobi.gt(0)) lines.push({ kind: "employer", code: "eobi_employer", label: "EOBI, employer's share", amount: employerEobi });
  if (employerSocialSecurity.gt(0)) lines.push({ kind: "employer", code: "social_security_employer", label: "Social security, employer's share", amount: employerSocialSecurity });

  return {
    ok: true,
    payslip: {
      employeeId: employee.id,
      userId: employee.userId,
      payBasis: employee.payBasis,
      daysInMonth: dim,
      daysEmployed: employed,
      daysWorked,
      unpaidDays,
      earnings,
      commission: commission.paid,
      commissionRecovered: commission.recovered,
      taxable: taxableMonth,
      tax,
      eobiEmployee,
      deductions,
      loanRecovery,
      net: left,
      employerEobi,
      employerSocialSecurity,
      taxableBefore: input.before.taxable,
      taxBefore: input.before.tax,
      monthsBefore: input.before.months,
      assumedMonths,
      assumedTaxable,
      assumedTax,
      monthsLeft,
      annualTaxable,
      annualTax,
      commissionBasis: input.commission,
      lines,
    },
  };
}

/** What a run's payslips add up to: the run's own figures. */
export function runTotals(payslips: readonly Payslip[]) {
  const total = (pick: (payslip: Payslip) => Decimal) => sum(payslips.map(pick));
  return {
    earnings: total((p) => p.earnings),
    commission: total((p) => p.commission),
    tax: total((p) => p.tax),
    eobiEmployee: total((p) => p.eobiEmployee),
    deductions: total((p) => p.deductions),
    loanRecovery: total((p) => p.loanRecovery),
    net: total((p) => p.net),
    employerEobi: total((p) => p.employerEobi),
    employerSocialSecurity: total((p) => p.employerSocialSecurity),
  };
}

/**
 * The approval's journal, as the database writes it (app.approve_payroll_run): pay less fixed
 * deductions and the employer's EOBI and social security are expensed; the commission carried
 * comes out of Commission payable, where it was expensed when earned; what the people take home,
 * the tax and the EOBI and social security are owed.
 */
export function approvalJournal(totals: Omit<ReturnType<typeof runTotals>, "loanRecovery"> & { loanRecovery?: Decimal }): { account: string; debit: Decimal; credit: Decimal }[] {
  // Instalments on loans go back to the loans, not off the salaries' cost (Step 42).
  const salaries = totals.earnings.minus(totals.deductions.minus(totals.loanRecovery ?? NIL));
  const employer = totals.employerEobi.plus(totals.employerSocialSecurity);
  const lines = [
    { account: "Salaries and wages", debit: Decimal.max(salaries, NIL), credit: Decimal.max(salaries.neg(), NIL) },
    { account: "Employer EOBI and social security", debit: employer, credit: NIL },
    { account: "Commission payable", debit: totals.commission, credit: NIL },
    { account: "Loans and advances to staff", debit: NIL, credit: totals.loanRecovery ?? NIL },
    { account: "Salaries payable", debit: NIL, credit: totals.net },
    { account: "Income tax withheld payable", debit: NIL, credit: totals.tax },
    { account: "EOBI and social security payable", debit: NIL, credit: totals.eobiEmployee.plus(employer) },
  ];
  return lines.filter((line) => line.debit.gt(0) || line.credit.gt(0));
}
