import { cleanText, readYesNo } from "@/lib/text";
import { currencyCodeSchema, currencyNameSchema } from "@/modules/currencies/rules";
import { readFirstYear } from "@/modules/numbering/rules";
import { MODULES, checkModuleChange, type ModuleKey, type ModuleState } from "@/modules/tenant/rules";

// Pure rules for the setup wizard. No I/O.
//
// A new company answers a handful of questions once: whether it is registered for sales tax, the
// currency its books are kept in, when its fiscal year starts, which parts of the product it
// wants, its first branch and warehouse, and which chart of accounts to start from. readSetup()
// cleans those answers or says what is wrong with them.

/** Sets of modules a company can start with. Everything can be switched later under Settings, Modules. */
export const MODULE_BUNDLES = {
  trading: {
    label: "Trading",
    about: "Sales, collections, purchases, stock, cash and bank.",
    modules: { sales: true, collections: true, purchasing: true, imports: false, inventory: true, cash_bank: true, commissions: false, payroll: false, fbr: false },
  },
  importer: {
    label: "Trading with imports",
    about: "Everything in Trading, plus shipments, customs charges and landed cost.",
    modules: { sales: true, collections: true, purchasing: true, imports: true, inventory: true, cash_bank: true, commissions: false, payroll: false, fbr: false },
  },
  full: {
    label: "Everything",
    about: "Trading with imports, plus sales commissions and payroll.",
    modules: { sales: true, collections: true, purchasing: true, imports: true, inventory: true, cash_bank: true, commissions: true, payroll: true, fbr: false },
  },
} as const satisfies Record<string, { label: string; about: string; modules: ModuleState }>;
export type BundleKey = keyof typeof MODULE_BUNDLES;
export const isBundle = (value: unknown): value is BundleKey => typeof value === "string" && Object.hasOwn(MODULE_BUNDLES, value);

/** The charts of accounts a company can start from. The accounts themselves are created with the ledger. */
export const ACCOUNT_TEMPLATES = {
  trading: "Trading company (importer, wholesaler, distributor)",
} as const;
export type AccountTemplate = keyof typeof ACCOUNT_TEMPLATES;
export const isAccountTemplate = (value: unknown): value is AccountTemplate => typeof value === "string" && Object.hasOwn(ACCOUNT_TEMPLATES, value);

/**
 * The switches to flip, in an order the dependency rules allow, to get from one set of modules
 * to another: a module is turned off only after everything that needs it, and on only after
 * everything it needs.
 */
export function moduleChanges(from: ModuleState, to: ModuleState): { module: ModuleKey; enabled: boolean }[] {
  const state = { ...from };
  const steps: { module: ModuleKey; enabled: boolean }[] = [];
  let pending = MODULES.filter((key) => state[key] !== to[key]);
  while (pending.length > 0) {
    const next = pending.find((key) => checkModuleChange(state, key, to[key]).ok);
    // A target that breaks the dependency rules cannot be reached; stop rather than loop.
    if (!next) throw new Error("that set of modules breaks the dependency rules");
    state[next] = to[next];
    steps.push({ module: next, enabled: to[next] });
    pending = pending.filter((key) => key !== next);
  }
  return steps;
}

export type SetupInput = {
  /** Whether the company is registered for sales tax. Not registered means no tax anywhere. */
  salesTaxRegistered: boolean;
  /** The company's own tax numbers, digits only; kept for its invoices. */
  ntn: string | null;
  strn: string | null;
  /** A registered company says it has checked the starting tax rates. */
  taxRatesConfirmed: boolean;
  /** Whether the company's prices already include sales tax. Always false when it is not registered. */
  pricesIncludeTax: boolean;
  baseCurrency: { code: string; name: string };
  /** The first day of the first fiscal year. */
  fiscalYearStart: string;
  bundle: BundleKey;
  branchName: string;
  warehouseName: string;
  accountsTemplate: AccountTemplate;
};

export type RawSetup = Partial<Record<"salesTaxRegistered" | "ntn" | "strn" | "taxRatesConfirmed" | "pricesIncludeTax" | "currencyCode" | "currencyName" | "fiscalMonth" | "fiscalYear" | "bundle" | "branchName" | "warehouseName" | "accountsTemplate", unknown>>;

/** Cleans the wizard's answers, or gives the first thing that is wrong in plain words. */
export function readSetup(raw: RawSetup): { ok: true; setup: SetupInput } | { ok: false; reason: string } {
  const registered = readYesNo(raw.salesTaxRegistered);
  if (registered === undefined || cleanText(raw.salesTaxRegistered) === "") return { ok: false, reason: "Say whether the company is registered for sales tax." };

  const digits = (value: unknown) => cleanText(value).replace(/[\s-]/g, "");
  let ntn: string | null = null;
  if (cleanText(raw.ntn) !== "") {
    const match = /^(\d{7})(\d)?$/.exec(digits(raw.ntn));
    if (!match) return { ok: false, reason: "NTN: 7 digits, with or without the check digit, such as 1234567-8." };
    ntn = match[2] ? `${match[1]}-${match[2]}` : match[1];
  }
  let strn: string | null = null;
  if (cleanText(raw.strn) !== "") {
    if (!/^\d{13}$/.test(digits(raw.strn))) return { ok: false, reason: "STRN: 13 digits." };
    strn = digits(raw.strn);
  }
  if (registered && strn === null) return { ok: false, reason: "Enter the company's STRN. A company registered for sales tax has one." };
  if (!registered && strn !== null) return { ok: false, reason: "Only a company registered for sales tax has an STRN." };
  const confirmed = readYesNo(raw.taxRatesConfirmed) === true;
  if (registered && !confirmed) return { ok: false, reason: "Tick the box to say you have checked the tax rates. They are listed under Settings, Tax." };
  // Never assumed: a registered company says which way its prices are.
  const taxInPrice = cleanText(raw.pricesIncludeTax) === "" ? undefined : readYesNo(raw.pricesIncludeTax);
  if (registered && taxInPrice === undefined) return { ok: false, reason: "Say whether your prices already include sales tax, or the tax is added on top." };

  const code = currencyCodeSchema.safeParse(raw.currencyCode);
  if (!code.success) return { ok: false, reason: "Currency: use the three-letter code, such as PKR." };
  const name = currencyNameSchema.safeParse(raw.currencyName);
  if (!name.success) return { ok: false, reason: "Enter the currency's name, such as Pakistani Rupee." };

  const year = readFirstYear({ month: raw.fiscalMonth, year: raw.fiscalYear });
  if (!year.ok) return { ok: false, reason: year.reason };

  if (!isBundle(raw.bundle)) return { ok: false, reason: "Choose what the company will use." };
  const branchName = cleanText(raw.branchName);
  if (branchName === "" || branchName.length > 80) return { ok: false, reason: "Enter the name of the first branch, such as Main." };
  const warehouseName = cleanText(raw.warehouseName);
  if (warehouseName === "" || warehouseName.length > 80) return { ok: false, reason: "Enter the name of the first warehouse, such as Main warehouse." };
  if (!isAccountTemplate(raw.accountsTemplate)) return { ok: false, reason: "Choose a chart of accounts to start from." };

  return {
    ok: true,
    setup: {
      salesTaxRegistered: registered,
      ntn,
      strn,
      taxRatesConfirmed: registered && confirmed,
      pricesIncludeTax: registered && taxInPrice === true,
      baseCurrency: { code: code.data, name: name.data },
      fiscalYearStart: year.start,
      bundle: raw.bundle,
      branchName,
      warehouseName,
      accountsTemplate: raw.accountsTemplate,
    },
  };
}
