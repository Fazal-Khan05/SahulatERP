import { describe, expect, it } from "vitest";
import { MODULES, checkModuleChange, resolveModules, type ModuleState } from "@/modules/tenant/rules";
import { MODULE_BUNDLES, moduleChanges, readSetup, type RawSetup } from "./rules";

const answers: RawSetup = {
  salesTaxRegistered: "no",
  currencyCode: "pkr",
  currencyName: "Pakistani Rupee",
  fiscalMonth: "7",
  fiscalYear: "2026",
  bundle: "importer",
  branchName: " Main ",
  warehouseName: "Main warehouse",
  accountsTemplate: "trading",
};
const reason = (raw: RawSetup) => {
  const read = readSetup(raw);
  return read.ok ? null : read.reason;
};

describe("readSetup", () => {
  it("reads the answers of a company that is not registered for sales tax", () => {
    expect(readSetup(answers)).toEqual({
      ok: true,
      setup: {
        salesTaxRegistered: false,
        ntn: null,
        strn: null,
        taxRatesConfirmed: false,
        baseCurrency: { code: "PKR", name: "Pakistani Rupee" },
        fiscalYearStart: "2026-07-01",
        bundle: "importer",
        branchName: "Main",
        warehouseName: "Main warehouse",
        accountsTemplate: "trading",
      },
    });
  });

  it("asks a registered company for its STRN and for a tick that the rates were checked", () => {
    const registered = { ...answers, salesTaxRegistered: "yes" };
    expect(reason(registered)).toBe("Enter the company's STRN. A company registered for sales tax has one.");
    expect(reason({ ...registered, strn: "11-11-1111-111-11" })).toBe("Tick the box to say you have checked the tax rates. They are listed under Settings, Tax.");
    const read = readSetup({ ...registered, strn: "11-11-1111-111-11", ntn: "1111111-1", taxRatesConfirmed: "on" });
    expect(read.ok && [read.setup.salesTaxRegistered, read.setup.strn, read.setup.ntn, read.setup.taxRatesConfirmed]).toEqual([true, "1111111111111", "1111111-1", true]);
    // An unregistered company has no STRN, and its tick means nothing.
    expect(reason({ ...answers, strn: "1111111111111" })).toBe("Only a company registered for sales tax has an STRN.");
    const unregistered = readSetup({ ...answers, taxRatesConfirmed: "on", ntn: "1111111" });
    expect(unregistered.ok && [unregistered.setup.taxRatesConfirmed, unregistered.setup.ntn]).toEqual([false, "1111111"]);
  });

  it.each<[RawSetup, string]>([
    [{ ...answers, salesTaxRegistered: "" }, "Say whether the company is registered for sales tax."],
    [{ ...answers, salesTaxRegistered: "maybe" }, "Say whether the company is registered for sales tax."],
    [{ ...answers, ntn: "12345" }, "NTN: 7 digits, with or without the check digit, such as 1234567-8."],
    [{ ...answers, currencyCode: "rupees" }, "Currency: use the three-letter code, such as PKR."],
    [{ ...answers, currencyName: "" }, "Enter the currency's name, such as Pakistani Rupee."],
    [{ ...answers, fiscalMonth: "13" }, "Choose the month the fiscal year starts."],
    [{ ...answers, fiscalYear: "26" }, "Enter the year the fiscal year starts, such as 2026."],
    [{ ...answers, bundle: "toString" }, "Choose what the company will use."],
    [{ ...answers, branchName: " " }, "Enter the name of the first branch, such as Main."],
    [{ ...answers, warehouseName: "" }, "Enter the name of the first warehouse, such as Main warehouse."],
    [{ ...answers, accountsTemplate: "constructor" }, "Choose a chart of accounts to start from."],
  ])("refuses %j", (raw, expected) => {
    expect(reason(raw)).toBe(expected);
  });
});

describe("module bundles", () => {
  const defaults = resolveModules({});
  const apply = (from: ModuleState, to: ModuleState) => {
    const state = { ...from };
    for (const step of moduleChanges(from, to)) {
      // Every step must be one the dependency rules allow at that moment.
      expect(checkModuleChange(state, step.module, step.enabled), `${step.module} ${step.enabled}`).toEqual({ ok: true });
      state[step.module] = step.enabled;
    }
    return state;
  };

  it("are each a set of modules the dependency rules allow, with FBR off", () => {
    for (const [key, bundle] of Object.entries(MODULE_BUNDLES)) {
      expect(Object.keys(bundle.modules).sort(), key).toEqual([...MODULES].sort());
      for (const name of MODULES) {
        if (bundle.modules[name]) expect(checkModuleChange({ ...bundle.modules, [name]: false }, name, true), `${key} ${name}`).toEqual({ ok: true });
      }
      expect(bundle.modules.fbr, key).toBe(false);
    }
  });

  it("can be reached from the defaults, and from each other, one allowed switch at a time", () => {
    const states: ModuleState[] = [defaults, ...Object.values(MODULE_BUNDLES).map((bundle) => bundle.modules)];
    for (const from of states) for (const to of states) expect(apply(from, to)).toEqual(to);
    // From the defaults, Trading turns off commissions and then imports, and nothing else.
    expect(moduleChanges(defaults, MODULE_BUNDLES.trading.modules)).toEqual([
      { module: "imports", enabled: false },
      { module: "commissions", enabled: false },
    ]);
    expect(moduleChanges(defaults, defaults)).toEqual([]);
  });

  it("refuses a target the rules cannot reach", () => {
    expect(() => moduleChanges(defaults, { ...defaults, inventory: false })).toThrow("breaks the dependency rules");
  });
});
