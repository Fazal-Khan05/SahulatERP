import { describe, expect, it } from "vitest";
import { IMPORT_MAX_ROWS, importColumns, partyChanges, readParty, readPartyImport, type PartyInput, type RawParty } from "./rules";

// Every tax number here is made up: repeated digits that belong to nobody.

const party = (kind: "customer" | "supplier", raw: RawParty): PartyInput => {
  const read = readParty(kind, raw);
  if (!read.ok) throw new Error(read.problems.join(" "));
  return read.party;
};
const problems = (kind: "customer" | "supplier", raw: RawParty): string[] => {
  const read = readParty(kind, raw);
  return read.ok ? [] : read.problems;
};

describe("readParty", () => {
  it("needs only a name, and fills in the plain defaults", () => {
    expect(party("customer", { name: "  Ali   Traders " })).toEqual({
      code: null,
      name: "Ali Traders",
      registrationType: "unregistered",
      ntn: null,
      cnic: null,
      strn: null,
      atlStatus: "unknown",
      province: null,
      creditDays: null,
      creditLimit: null,
      customerClass: null,
      isWithholdingAgent: false,
      supplierType: null,
      contactName: null,
      phone: null,
      email: null,
      address: null,
      city: null,
    });
    expect(party("supplier", { name: "Guangzhou Parts Co" }).supplierType).toBe("company");
  });

  it("reads every field of a customer and stores tax numbers as digits", () => {
    const read = party("customer", {
      code: "C-001",
      name: "Khan Autos",
      registrationType: "Registered",
      ntn: "1111111-1",
      cnic: "11111-1111111-1",
      strn: "11-11-1111-111-11",
      atlStatus: "Active",
      province: "KPK",
      creditLimit: "500000.50",
      creditDays: "30",
      customerClass: "Wholesale",
      withholdingAgent: "yes",
      contactName: "Accounts Desk",
      phone: "0300-1111111",
      email: "Accounts@KhanAutos.test",
      address: "12 Circular Road",
      city: "Peshawar",
    });
    expect(read).toMatchObject({
      code: "C-001",
      registrationType: "registered",
      ntn: "1111111-1",
      cnic: "1111111111111",
      strn: "1111111111111",
      atlStatus: "active",
      province: "khyber_pakhtunkhwa",
      creditLimit: "500000.5000",
      creditDays: 30,
      customerClass: "Wholesale",
      isWithholdingAgent: true,
      email: "accounts@khanautos.test",
      city: "Peshawar",
    });
  });

  it("reads a choice by its key, its label or a common short form", () => {
    expect(party("customer", { name: "Ab", province: "Islamabad Capital Territory" }).province).toBe("islamabad");
    expect(party("customer", { name: "Ab", province: "ict" }).province).toBe("islamabad");
    expect(party("customer", { name: "Ab", atlStatus: "Not on the list" }).atlStatus).toBe("inactive");
    expect(party("customer", { name: "Ab", atlStatus: "filer" }).atlStatus).toBe("active");
    expect(party("supplier", { name: "Ab", supplierType: "Association of persons (AOP)" }).supplierType).toBe("aop");
    expect(party("supplier", { name: "Ab", supplierType: "individual" }).supplierType).toBe("individual");
    expect(party("customer", { name: "Ab", withholdingAgent: "on" }).isWithholdingAgent).toBe(true);
    expect(party("customer", { name: "Ab", withholdingAgent: "No" }).isWithholdingAgent).toBe(false);
    expect(party("customer", { name: "Ab", ntn: "1111111" }).ntn).toBe("1111111");
  });

  it("lists every problem at once, in plain words", () => {
    expect(
      problems("customer", {
        name: "",
        code: "bad code!",
        registrationType: "maybe",
        ntn: "12345",
        cnic: "1111",
        strn: "abc",
        atlStatus: "perhaps",
        province: "Mars",
        creditLimit: "5,00,000",
        creditDays: "400",
        withholdingAgent: "sometimes",
        phone: "call me",
        email: "not-an-email",
      }),
    ).toEqual([
      "Enter the name.",
      "Code: use up to 20 letters, digits, dots, dashes or slashes.",
      "Registration: write Registered or Unregistered.",
      "NTN: 7 digits, with or without the check digit, such as 1234567-8.",
      "CNIC: 13 digits.",
      "STRN: 13 digits.",
      "Only a customer registered for sales tax has an STRN.",
      "ATL status: write Active, Inactive or Unknown.",
      "Province: one of Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu and Kashmir.",
      "Credit days: a whole number from 0 to 365.",
      "Credit limit: Enter the amount as a plain number without commas, such as 500000.",
      "Withholding agent: write Yes or No.",
      "Phone: digits only, such as 0300-1234567.",
      "Email: enter a valid email address.",
    ]);
  });

  it("ties the STRN to being registered", () => {
    expect(problems("supplier", { name: "Ab", registrationType: "registered" })).toEqual([
      "A supplier registered for sales tax needs an NTN, an STRN or a CNIC.",
    ]);
    // A registered individual may be known by the CNIC alone.
    expect(problems("supplier", { name: "Ab", registrationType: "registered", cnic: "1111111111111" })).toEqual([]);
    expect(problems("supplier", { name: "Ab", registrationType: "registered", strn: "1111111111111" })).toEqual([]);
    expect(problems("customer", { name: "Ab", strn: "1111111111111" })).toEqual(["Only a customer registered for sales tax has an STRN."]);
  });

  it("keeps each kind's own fields to that kind", () => {
    // A supplier has no credit limit or class, whatever is sent; a customer has no supplier type.
    const supplier = party("supplier", { name: "Ab", creditLimit: "nonsense", customerClass: "x", withholdingAgent: "yes" });
    expect([supplier.creditLimit, supplier.customerClass, supplier.isWithholdingAgent]).toEqual([null, null, false]);
    expect(party("customer", { name: "Ab", supplierType: "nonsense" }).supplierType).toBeNull();
    expect(problems("supplier", { name: "Ab", supplierType: "shop" })).toEqual(["Supplier type: write Company, Individual or AOP."]);
  });

  it("never takes a word every object answers to as a choice", () => {
    for (const field of ["registrationType", "atlStatus", "province"] as const) {
      expect(problems("customer", { name: "Ab", [field]: "constructor" }), field).toHaveLength(1);
      expect(problems("customer", { name: "Ab", [field]: "toString" }), field).toHaveLength(1);
    }
    expect(problems("supplier", { name: "Ab", supplierType: "constructor" })).toEqual(["Supplier type: write Company, Individual or AOP."]);
  });

  it("drops characters nobody can see and counts a name by its characters", () => {
    // Control characters become a space; zero-width ones vanish; neither can make a name.
    expect(party("customer", { name: "Ali\u0000Traders\u200b" }).name).toBe("Ali Traders");
    expect(party("customer", { name: "Ab", address: "12 Circular Road\nLahore" }).address).toBe("12 Circular Road Lahore");
    expect(problems("customer", { name: "\u200b\u200b\u200b" })).toEqual(["Enter the name."]);
    expect(problems("customer", { name: "\u{1F600}" })).toEqual(["Enter the name."]);
  });

  it("refuses anything that is not text", () => {
    expect(problems("customer", { name: 42 })).toEqual(["Enter the name."]);
    expect(problems("customer", { name: "Ab", creditDays: "3.5" })).toEqual(["Credit days: a whole number from 0 to 365."]);
  });
});

describe("partyChanges", () => {
  it("keeps only the fields that differ", () => {
    const before = party("customer", { name: "Ali Traders", creditDays: "30", city: "Lahore" });
    const after = party("customer", { name: "Ali Traders", creditDays: "45", city: "Lahore", phone: "0300-1111111" });
    expect(partyChanges(before, after)).toEqual({
      before: { creditDays: 30, phone: null },
      after: { creditDays: 45, phone: "0300-1111111" },
    });
    expect(partyChanges(before, before)).toEqual({ before: {}, after: {} });
  });
});

describe("readPartyImport", () => {
  it("knows which columns each kind of party has", () => {
    const customer = importColumns("customer").map((c) => c.header);
    const supplier = importColumns("supplier").map((c) => c.header);
    expect(customer).toContain("Credit limit");
    expect(customer).not.toContain("Supplier type");
    expect(supplier).toContain("Supplier type");
    expect(supplier).not.toContain("Credit limit");
    expect(supplier).not.toContain("Class");
  });

  it("reads a file whose columns are in any order and headed in any case", () => {
    const read = readPartyImport("customer", "city,NAME,Credit Limit,ntn\nLahore,Ali Traders,250000,1111111\n,Bilal & Sons,,\n");
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.parties.map((p) => [p.row, p.party.name, p.party.city, p.party.creditLimit, p.party.ntn])).toEqual([
      [2, "Ali Traders", "Lahore", "250000.0000", "1111111"],
      [3, "Bilal & Sons", null, null, null],
    ]);
  });

  it("imports nothing from 500 rows when 3 are bad, and lists the 3", () => {
    const lines = ["Code,Name,NTN,Credit days,City"];
    for (let i = 1; i <= 500; i++) lines.push(`C${String(i).padStart(4, "0")},Customer ${i},,30,Lahore`);
    lines[120] = "C0120,,,30,Lahore"; // row 121: no name
    lines[250] = "C0250,Customer 250,12345,30,Lahore"; // row 251: an NTN that is not an NTN
    lines[400] = "C0400,Customer 7,,30,Lahore"; // row 401: the name of row 8 again
    const read = readPartyImport("customer", lines.join("\n"));
    expect(read.status).toBe("rejected");
    if (read.status !== "rejected") return;
    expect(read.problems).toEqual([
      { row: 121, name: "", problems: ["Enter the name."] },
      { row: 251, name: "Customer 250", problems: ["NTN: 7 digits, with or without the check digit, such as 1234567-8."] },
      { row: 401, name: "Customer 7", problems: ["The same name is in row 8."] },
    ]);
    // The other 497 are handed back only so the caller can check them too; none may be kept.
    expect(read.parties).toHaveLength(497);
    // The same file with those three rows put right is ready, all 500 of it.
    lines[120] = "C0120,Customer 120,,30,Lahore";
    lines[250] = "C0250,Customer 250,1111111,30,Lahore";
    lines[400] = "C0400,Customer 400,,30,Lahore";
    const fixed = readPartyImport("customer", lines.join("\n"));
    expect(fixed.status === "ready" && fixed.parties.length).toBe(500);
  });

  it("catches a code used twice, a name differing only by capitals, and a row with too many cells", () => {
    const read = readPartyImport("supplier", "Code,Name\nS1,Alpha\ns1,Beta\nS3,ALPHA\nS4,Gamma,extra\n");
    expect(read.status === "rejected" && read.problems).toEqual([
      { row: 3, name: "Beta", problems: ["The same code is in row 2."] },
      { row: 4, name: "ALPHA", problems: ["The same name is in row 2."] },
      { row: 5, name: "Gamma", problems: ["This row has more cells than the file has columns (2). Check for a stray comma."] },
    ]);
  });

  it("numbers rows as a spreadsheet does, empty lines and multi-line cells included", () => {
    const badRows = (csv: string) => {
      const read = readPartyImport("customer", csv);
      return read.status === "rejected" ? read.problems.map((p) => [p.row, ...p.problems]) : read.status;
    };
    // An empty line between rows still counts: "x" is on row 4 of the sheet.
    expect(badRows("Name\nAli Traders\n\nx\n")).toEqual([[4, "Enter the name."]]);
    // An empty line above the heading: the heading is row 2, "x" row 4, and the repeat points at row 3.
    expect(badRows("\nName\nAli Traders\nx\nali traders\n")).toEqual([
      [4, "Enter the name."],
      [5, "The same name is in row 3."],
    ]);
    // A cell with a line break in it is one row, and the byte-order mark is not a character of the heading.
    expect(badRows('\ufeffName,Address\nAli Traders,"12 Circular Road\nLahore"\nx,\n')).toEqual([[3, "Enter the name."]]);
  });

  it("puts up with the empty columns a spreadsheet leaves on the right", () => {
    const read = readPartyImport("customer", "Name,City,,\nAli Traders,Lahore,,\nBilal & Sons,,,\n");
    expect(read.status === "ready" && read.parties.map((p) => [p.party.name, p.party.city])).toEqual([
      ["Ali Traders", "Lahore"],
      ["Bilal & Sons", null],
    ]);
  });

  it("skips rows of empty cells and counts rows as the file numbers them", () => {
    const read = readPartyImport("customer", "Name,City\n,\nAli Traders,Lahore\n,,\n");
    expect(read.status === "ready" && read.parties.map((p) => p.row)).toEqual([3]);
  });

  it("refuses a file it cannot use as a whole, saying why", () => {
    const reason = (kind: "customer" | "supplier", csv: string) => {
      const read = readPartyImport(kind, csv);
      return read.status === "unreadable" ? read.reason : read.status;
    };
    expect(reason("customer", "")).toBe("The file is empty.");
    expect(reason("customer", "Name,City\n")).toBe("The file has a heading row but no rows under it.");
    expect(reason("customer", "City\nLahore\n")).toBe('The file needs a "Name" column in its first row.');
    expect(reason("customer", "Name,Salary\nAli,5\n")).toBe('The column "Salary" is not one this import knows. Rename or remove it.');
    expect(reason("supplier", "Name,Credit limit\nAli,5\n")).toBe('The column "Credit limit" is not one this import knows. Rename or remove it.');
    expect(reason("customer", "Name,name\nAli,Ali\n")).toBe('The column "Name" is in the file twice.');
    expect(reason("customer", 'Name\n"Ali\n')).toBe("A quote opened on line 2 is never closed.");
    // A file saved in an older encoding arrives with this character where its accents were.
    expect(reason("customer", "Name\nCaf\ufffd Traders\n")).toBe(
      'The file is not saved as UTF-8. In Excel, save it as "CSV UTF-8 (Comma delimited)" and import it again.',
    );
    const many = ["Name", ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `Customer ${i}`)].join("\n");
    expect(reason("customer", many)).toBe(`The file has ${IMPORT_MAX_ROWS + 1} rows. Import at most ${IMPORT_MAX_ROWS} at a time.`);
  });
});
