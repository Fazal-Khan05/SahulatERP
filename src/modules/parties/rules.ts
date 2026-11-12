import { parseCsv } from "@/lib/csv";
import { AMOUNT_SCALE, parseAmount } from "@/lib/money";
import { emailSchema } from "@/modules/tenant/rules";

// Pure rules for customers and suppliers. No I/O.
//
// A party is read the same way whether it comes from the form or from a line of a CSV file:
// readParty() takes the raw text of each field and returns either the cleaned party or every
// problem it found, in plain words. An import is all or nothing: one bad row and no row is kept.

export const PARTY_KINDS = ["customer", "supplier"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const PARTY_WORDS: Record<PartyKind, { one: string; many: string; path: string }> = {
  customer: { one: "customer", many: "Customers", path: "/customers" },
  supplier: { one: "supplier", many: "Suppliers", path: "/suppliers" },
};

export const REGISTRATION_TYPES = ["unregistered", "registered"] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];
export const REGISTRATION_LABELS: Record<RegistrationType, string> = {
  unregistered: "Not registered for sales tax",
  registered: "Registered for sales tax",
};

// Whether the party is on FBR's Active Taxpayers List, as last checked.
export const ATL_STATUSES = ["unknown", "active", "inactive"] as const;
export type AtlStatus = (typeof ATL_STATUSES)[number];
export const ATL_LABELS: Record<AtlStatus, string> = {
  unknown: "Not checked",
  active: "On the list",
  inactive: "Not on the list",
};

export const PROVINCES = [
  "punjab",
  "sindh",
  "khyber_pakhtunkhwa",
  "balochistan",
  "islamabad",
  "gilgit_baltistan",
  "azad_kashmir",
] as const;
export type Province = (typeof PROVINCES)[number];
export const PROVINCE_LABELS: Record<Province, string> = {
  punjab: "Punjab",
  sindh: "Sindh",
  khyber_pakhtunkhwa: "Khyber Pakhtunkhwa",
  balochistan: "Balochistan",
  islamabad: "Islamabad Capital Territory",
  gilgit_baltistan: "Gilgit-Baltistan",
  azad_kashmir: "Azad Jammu and Kashmir",
};

// What the supplier is for income tax: the rate deducted from a payment depends on it.
export const SUPPLIER_TYPES = ["company", "individual", "aop"] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];
export const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  company: "Company",
  individual: "Individual",
  aop: "Association of persons (AOP)",
};

/** A party as stored. Fields that belong to the other kind of party are null or false. */
export type PartyInput = {
  code: string | null;
  name: string;
  registrationType: RegistrationType;
  ntn: string | null;
  cnic: string | null;
  strn: string | null;
  atlStatus: AtlStatus;
  province: Province | null;
  creditDays: number | null;
  /** Customers only. The exact decimal as text, such as "500000.0000". */
  creditLimit: string | null;
  /** Customers only. */
  customerClass: string | null;
  /** Customers only: the customer deducts tax when it pays. */
  isWithholdingAgent: boolean;
  /** Customers only: the price list the customer is on; null means the company's default list. */
  priceListId: string | null;
  /** Suppliers only. */
  supplierType: SupplierType | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
};

/** The raw text of each field, by the name the form and the import use. */
export type RawParty = Partial<Record<(typeof FIELDS)[number]["key"] | "priceListId", unknown>>;

// Every field: its key, its column heading in a CSV file, and which kind of party has it.
const FIELDS = [
  { key: "code", header: "Code" },
  { key: "name", header: "Name" },
  { key: "supplierType", header: "Supplier type", only: "supplier" },
  { key: "registrationType", header: "Registration" },
  { key: "ntn", header: "NTN" },
  { key: "cnic", header: "CNIC" },
  { key: "strn", header: "STRN" },
  { key: "atlStatus", header: "ATL status" },
  { key: "province", header: "Province" },
  { key: "creditLimit", header: "Credit limit", only: "customer" },
  { key: "creditDays", header: "Credit days" },
  { key: "customerClass", header: "Class", only: "customer" },
  { key: "withholdingAgent", header: "Withholding agent", only: "customer" },
  { key: "contactName", header: "Contact person" },
  { key: "phone", header: "Phone" },
  { key: "email", header: "Email" },
  { key: "address", header: "Address" },
  { key: "city", header: "City" },
] as const satisfies readonly { key: string; header: string; only?: PartyKind }[];

/** The columns a CSV file for this kind of party may have, in the order the screen lists them. */
export function importColumns(kind: PartyKind): { key: keyof RawParty; header: string }[] {
  return FIELDS.filter((field) => !("only" in field) || field.only === kind);
}

// ── Reading one party ───────────────────────────────────────────────────────────────────────────

/** A field as text: invisible characters dropped, control characters and runs of spaces made one space. */
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
        .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .replace(/\s+/g, " ")
    : "";
/** Letters and digits only, lower case: how a heading or a choice is compared. */
const plain = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function choice<T extends string>(value: string, labels: Record<T, string>, aliases: Record<string, T> = {}): T | undefined {
  const wanted = plain(value);
  for (const key of Object.keys(labels) as T[]) {
    if (plain(key) === wanted || plain(labels[key]) === wanted) return key;
  }
  // Only the aliases themselves: never a word every object happens to answer to.
  return Object.hasOwn(aliases, wanted) ? aliases[wanted] : undefined;
}

const REGISTRATION_ALIASES: Record<string, RegistrationType> = { registered: "registered", yes: "registered", unregistered: "unregistered", notregistered: "unregistered", no: "unregistered" };
const ATL_ALIASES: Record<string, AtlStatus> = { active: "active", filer: "active", yes: "active", inactive: "inactive", nonfiler: "inactive", no: "inactive", unknown: "unknown" };
const PROVINCE_ALIASES: Record<string, Province> = { kp: "khyber_pakhtunkhwa", kpk: "khyber_pakhtunkhwa", ict: "islamabad", islamabad: "islamabad", gb: "gilgit_baltistan", ajk: "azad_kashmir", azadkashmir: "azad_kashmir" };
const SUPPLIER_TYPE_ALIASES: Record<string, SupplierType> = { aop: "aop", associationofpersons: "aop", firm: "aop", partnership: "aop" };
const YES = new Set(["yes", "y", "true", "1", "on"]);
const NO = new Set(["", "no", "n", "false", "0", "off"]);

/**
 * Cleans one party, or lists everything wrong with it. Never guesses: a field that cannot be
 * read as what it should be is a problem, not a blank.
 */
export function readParty(kind: PartyKind, raw: RawParty): { ok: true; party: PartyInput } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const optional = (value: unknown, max: number, what: string): string | null => {
    const cleaned = text(value);
    if (cleaned.length > max) problems.push(`${what}: use at most ${max} characters.`);
    return cleaned === "" ? null : cleaned;
  };

  const name = text(raw.name);
  // Counted as the database counts: by character, not by UTF-16 unit.
  if ([...name].length < 2) problems.push("Enter the name.");
  else if (name.length > 120) problems.push("Name: use at most 120 characters.");

  const code = text(raw.code) || null;
  if (code !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/.test(code)) {
    problems.push("Code: use up to 20 letters, digits, dots, dashes or slashes.");
  }

  let registrationType: RegistrationType = "unregistered";
  if (text(raw.registrationType) !== "") {
    const found = choice(text(raw.registrationType), REGISTRATION_LABELS, REGISTRATION_ALIASES);
    if (found) registrationType = found;
    else problems.push("Registration: write Registered or Unregistered.");
  }

  const digits = (value: unknown) => text(value).replace(/[\s-]/g, "");
  let ntn: string | null = null;
  if (text(raw.ntn) !== "") {
    const match = /^(\d{7})(\d)?$/.exec(digits(raw.ntn));
    if (match) ntn = match[2] ? `${match[1]}-${match[2]}` : match[1];
    else problems.push("NTN: 7 digits, with or without the check digit, such as 1234567-8.");
  }
  let cnic: string | null = null;
  if (text(raw.cnic) !== "") {
    if (/^\d{13}$/.test(digits(raw.cnic))) cnic = digits(raw.cnic);
    else problems.push("CNIC: 13 digits.");
  }
  let strn: string | null = null;
  if (text(raw.strn) !== "") {
    if (/^\d{13}$/.test(digits(raw.strn))) strn = digits(raw.strn);
    else problems.push("STRN: 13 digits.");
  }
  if (registrationType === "registered" && text(raw.ntn) === "" && text(raw.strn) === "" && text(raw.cnic) === "") {
    problems.push(`A ${PARTY_WORDS[kind].one} registered for sales tax needs an NTN, an STRN or a CNIC.`);
  }
  if (registrationType === "unregistered" && text(raw.strn) !== "") {
    problems.push(`Only a ${PARTY_WORDS[kind].one} registered for sales tax has an STRN.`);
  }

  let atlStatus: AtlStatus = "unknown";
  if (text(raw.atlStatus) !== "") {
    const found = choice(text(raw.atlStatus), ATL_LABELS, ATL_ALIASES);
    if (found) atlStatus = found;
    else problems.push("ATL status: write Active, Inactive or Unknown.");
  }

  let province: Province | null = null;
  if (text(raw.province) !== "") {
    province = choice(text(raw.province), PROVINCE_LABELS, PROVINCE_ALIASES) ?? null;
    if (province === null) problems.push(`Province: one of ${Object.values(PROVINCE_LABELS).join(", ")}.`);
  }

  let creditDays: number | null = null;
  if (text(raw.creditDays) !== "") {
    if (/^\d{1,3}$/.test(text(raw.creditDays)) && Number(text(raw.creditDays)) <= 365) creditDays = Number(text(raw.creditDays));
    else problems.push("Credit days: a whole number from 0 to 365.");
  }

  let creditLimit: string | null = null;
  let customerClass: string | null = null;
  let isWithholdingAgent = false;
  let supplierType: SupplierType | null = null;
  let priceListId: string | null = null;
  if (kind === "customer") {
    // Chosen from a list on the form; a file does not carry it.
    const chosen = text(raw.priceListId);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chosen)) priceListId = chosen.toLowerCase();
    else if (chosen !== "") problems.push("Choose a price list from the list.");
    if (text(raw.creditLimit) !== "") {
      const parsed = parseAmount(raw.creditLimit);
      if (parsed.ok) creditLimit = parsed.amount.toFixed(AMOUNT_SCALE);
      else problems.push(`Credit limit: ${parsed.reason}`);
    }
    customerClass = optional(raw.customerClass, 40, "Class");
    const agent = plain(text(raw.withholdingAgent));
    if (YES.has(agent)) isWithholdingAgent = true;
    else if (!NO.has(agent)) problems.push("Withholding agent: write Yes or No.");
  } else {
    supplierType = "company";
    if (text(raw.supplierType) !== "") {
      const found = choice(text(raw.supplierType), SUPPLIER_TYPE_LABELS, SUPPLIER_TYPE_ALIASES);
      if (found) supplierType = found;
      else problems.push("Supplier type: write Company, Individual or AOP.");
    }
  }

  const contactName = optional(raw.contactName, 80, "Contact person");
  const phone = text(raw.phone) || null;
  if (phone !== null && !/^[0-9+()\-\s]{5,30}$/.test(phone)) problems.push("Phone: digits only, such as 0300-1234567.");
  let email: string | null = null;
  if (text(raw.email) !== "") {
    const parsed = emailSchema.safeParse(raw.email);
    if (parsed.success) email = parsed.data;
    else problems.push("Email: enter a valid email address.");
  }
  const address = optional(raw.address, 200, "Address");
  const city = optional(raw.city, 60, "City");

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    party: {
      code,
      name,
      registrationType,
      ntn,
      cnic,
      strn,
      atlStatus,
      province,
      creditDays,
      creditLimit,
      customerClass,
      isWithholdingAgent,
      priceListId,
      supplierType,
      contactName,
      phone,
      email,
      address,
      city,
    },
  };
}

/** The fields that differ between two versions of a party, for the audit row of an update. */
export function partyChanges(before: PartyInput, after: PartyInput): { before: Partial<PartyInput>; after: Partial<PartyInput> } {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof PartyInput)[]) {
    if (before[key] !== after[key]) {
      was[key] = before[key];
      now[key] = after[key];
    }
  }
  return { before: was, after: now };
}

// ── Reading an import file ──────────────────────────────────────────────────────────────────────

/** Which module's switch each list follows: off means its screens and actions are closed. */
export const PARTY_MODULE = { customer: "sales", supplier: "purchasing" } as const satisfies Record<PartyKind, string>;

export const IMPORT_MAX_ROWS = 2000;
/** The largest file the import accepts; 2,000 full rows fit several times over. */
export const IMPORT_MAX_BYTES = 800 * 1024;

/** One row that cannot be imported. `row` is its line in the file, the heading being row 1. */
export type ImportProblem = { row: number; name: string; problems: string[] };

export type ImportRead =
  | { status: "ready"; parties: { row: number; party: PartyInput }[] }
  /** The file as a whole cannot be used. */
  | { status: "unreadable"; reason: string }
  /**
   * The file is readable but these rows are wrong; nothing may be imported. `parties` are the
   * rows that read cleanly, so the caller can check those too and report everything at once.
   */
  | { status: "rejected"; problems: ImportProblem[]; parties: { row: number; party: PartyInput }[] };

/**
 * Reads a CSV file of parties. The first row names the columns; each later row is one party,
 * checked exactly as the form would check it. A name or code used twice in the file is a
 * problem on the later row. Rows are numbered as a spreadsheet shows them, empty rows included.
 */
export function readPartyImport(kind: PartyKind, csv: string): ImportRead {
  // Bytes that are not UTF-8 arrive as this character; importing them would store garbled names.
  if (csv.includes("\ufffd")) {
    return { status: "unreadable", reason: 'The file is not saved as UTF-8. In Excel, save it as "CSV UTF-8 (Comma delimited)" and import it again.' };
  }
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { status: "unreadable", reason: parsed.reason };
  const filled = (cells: string[]) => cells.some((cell) => text(cell) !== "");
  const headingAt = parsed.rows.findIndex(filled);
  if (headingAt === -1) return { status: "unreadable", reason: "The file is empty." };
  // A spreadsheet that once had more columns leaves empty cells at the end of every row.
  const headings = [...parsed.rows[headingAt]];
  while (headings.length > 0 && text(headings[headings.length - 1]) === "") headings.pop();

  const columns = importColumns(kind);
  const keys: (keyof RawParty)[] = [];
  for (const heading of headings) {
    const column = columns.find((c) => plain(c.header) === plain(heading) || plain(c.key) === plain(heading));
    if (!column) {
      return { status: "unreadable", reason: `The column "${heading.trim().slice(0, 40)}" is not one this import knows. Rename or remove it.` };
    }
    if (keys.includes(column.key)) return { status: "unreadable", reason: `The column "${column.header}" is in the file twice.` };
    keys.push(column.key);
  }
  if (!keys.includes("name")) return { status: "unreadable", reason: 'The file needs a "Name" column in its first row.' };

  // A row of empty cells is not a party, but it still counts when rows are numbered.
  const rows = parsed.rows
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter(({ cells, row }) => row > headingAt + 1 && filled(cells));
  if (rows.length === 0) return { status: "unreadable", reason: "The file has a heading row but no rows under it." };
  if (rows.length > IMPORT_MAX_ROWS) {
    return { status: "unreadable", reason: `The file has ${rows.length} rows. Import at most ${IMPORT_MAX_ROWS} at a time.` };
  }

  const parties: { row: number; party: PartyInput }[] = [];
  const problems: ImportProblem[] = [];
  const namesSeen = new Map<string, number>();
  const codesSeen = new Map<string, number>();
  for (const { cells, row } of rows) {
    const found: string[] = [];
    if (filled(cells.slice(keys.length))) {
      found.push(`This row has more cells than the file has columns (${keys.length}). Check for a stray comma.`);
    }
    const raw: RawParty = Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ""]));
    const read = readParty(kind, raw);
    if (!read.ok) found.push(...read.problems);

    const nameKey = text(raw.name).toLowerCase();
    if (nameKey !== "") {
      const first = namesSeen.get(nameKey);
      if (first !== undefined) found.push(`The same name is in row ${first}.`);
      else namesSeen.set(nameKey, row);
    }
    const codeKey = text(raw.code).toLowerCase();
    if (codeKey !== "") {
      const first = codesSeen.get(codeKey);
      if (first !== undefined) found.push(`The same code is in row ${first}.`);
      else codesSeen.set(codeKey, row);
    }

    if (found.length > 0) problems.push({ row, name: text(raw.name).slice(0, 120), problems: found });
    else if (read.ok) parties.push({ row, party: read.party });
  }
  return problems.length > 0 ? { status: "rejected", problems, parties } : { status: "ready", parties };
}
