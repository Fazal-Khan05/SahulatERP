import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { annualStatementCsv, bankFile, bankName, checkBankFile, isPakistaniIban, readBankAccount, readLoan, tidyIban } from "./rules";

// Step 42's rules on their own: IBANs, the salary bank file and its checks, loans, and the year's
// statement.

describe("IBANs", () => {
  it("knows a Pakistani IBAN by its shape and its check digits", () => {
    expect(["PK36SCBL0000001123456702", "PK72HABB0012345678901234", "PK13MEZN0001020304050607"].map(isPakistaniIban)).toEqual([true, true, true]);
    // One digit wrong, the check digits wrong, too short, not Pakistani.
    expect(["PK36SCBL0000001123456703", "PK37SCBL0000001123456702", "PK36SCBL000000112345670", "GB82WEST12345698765432"].map(isPakistaniIban)).toEqual([false, false, false, false]);
    expect(tidyIban(" pk36 scbl-0000 0011 2345 6702 ")).toBe("PK36SCBL0000001123456702");
    expect(readBankAccount({ bankName: "Standard Chartered", accountTitle: "Ali Raza", iban: "PK36SCBL0000001123456703" })).toEqual({
      ok: false,
      reason: "Enter the IBAN: PK, two digits, the bank's four letters and sixteen digits, as on the bank's letter or cheque book.",
    });
  });
});

describe("the salary bank file", () => {
  const rows = [
    { iban: "PK36SCBL0000001123456702", name: "Ali Raza", amount: new Decimal("90000"), reference: "SALARY Nov 2026 E-001" },
    { iban: "PK72HABB0012345678901234", name: "Sára Khán, (Mrs)", amount: new Decimal("54321.5"), reference: "SALARY Nov 2026 E-002" },
  ];

  it("writes one line for each person, in the bank's characters, to the paisa, and passes its own checks", () => {
    const csv = bankFile(rows);
    expect(csv.split("\r\n")).toEqual([
      "Sr No,Beneficiary IBAN,Beneficiary Name,Amount,Payment Reference",
      "1,PK36SCBL0000001123456702,ALI RAZA,90000.00,SALARY NOV 2026 E-001",
      "2,PK72HABB0012345678901234,SARA KHAN MRS,54321.50,SALARY NOV 2026 E-002",
      "",
    ]);
    expect(checkBankFile(csv)).toEqual([]);
    expect(bankName("Muhammad Abdul Rehman Siddiqui Qureshi Khan")).toHaveLength(35);
  });

  it("finds what a bank would refuse", () => {
    const bad = [
      "Sr No,Beneficiary IBAN,Beneficiary Name,Amount,Payment Reference",
      "1,PK36SCBL0000001123456703,ALI,100.00,X",
      "2,PK72HABB0012345678901234,sara,100.00,X",
      "3,PK72HABB0012345678901234,SARA,0.00,",
      "4,PK13MEZN0001020304050607,AHMED,1,000.00,X",
    ].join("\r\n");
    expect(checkBankFile(bad)).toEqual([
      "Line 2: PK36SCBL0000001123456703 is not an IBAN.",
      "Line 3: the name has characters a bank file does not take, or is longer than 35.",
      "Line 4: PK72HABB0012345678901234 is paid twice.",
      "Line 4: the amount must be above nil, to the paisa, without commas.",
      "Line 4: the reference must be 1 to 30 characters.",
      "Line 5: 5 fields are needed.",
    ]);
    expect(checkBankFile("IBAN,Amount\r\n")).toEqual(["The heading must be: Sr No,Beneficiary IBAN,Beneficiary Name,Amount,Payment Reference"]);
  });
});

describe("loans", () => {
  it("reads a loan, refusing what will not do", () => {
    const loan = { employeeId: "e", date: "2026-11-05", amount: "30,000", instalment: "10000", accountId: "a" };
    expect(readLoan(loan, "2026-11-18")).toMatchObject({ ok: true, loan: { amount: new Decimal(30000), instalment: new Decimal(10000), note: null } });
    expect(readLoan({ ...loan, instalment: "40000" }, "2026-11-18")).toEqual({ ok: false, reason: "The instalment cannot be more than the loan." });
    expect(readLoan({ ...loan, date: "2026-11-30" }, "2026-11-18")).toEqual({ ok: false, reason: "That day has not come yet. Nothing is recorded before it happens." });
    expect(readLoan({ ...loan, amount: "-5" }, "2026-11-18")).toEqual({ ok: false, reason: "Enter the loan's amount, in rupees and paisa." });
  });
});

describe("the year's salary statement", () => {
  it("is a line a person and the totals, with a CNIC never read as a formula", () => {
    const csv = annualStatementCsv(
      [
        { code: "E-001", name: "Ali Raza", cnic: "3520212345671", months: 4, pay: new Decimal(400000), taxable: new Decimal(400000), tax: new Decimal(3000) },
        { code: "=X", name: "Sara", cnic: null, months: 2, pay: new Decimal(100000), taxable: new Decimal(90000), tax: new Decimal(0) },
      ],
      2026,
    );
    expect(csv.split("\r\n")).toEqual([
      '"Salary paid and income tax deducted (s.149), Tax Year 2027: 1 July 2026 to 30 June 2027"',
      "Code,Name,CNIC,Months paid,Pay and commission,Taxable salary,Income tax deducted",
      "E-001,Ali Raza,3520212345671,4,400000.00,400000.00,3000.00",
      "'=X,Sara,,2,100000.00,90000.00,0.00",
      ",Total,,,500000.00,490000.00,3000.00",
      "",
    ]);
  });
});
