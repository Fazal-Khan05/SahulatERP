import { describe, expect, it } from "vitest";
import {
  LOGO_MAX_BYTES,
  MEMBER_ROLES,
  MODULES,
  MODULE_INFO,
  ROLE_LABELS,
  can,
  checkLogo,
  checkModuleChange,
  companyNameSchema,
  emailSchema,
  inviteSchema,
  navFor,
  newPasswordSchema,
  productNameSchema,
  resolveActiveMembership,
  resolveModules,
  seesBranch,
  type ModuleKey,
} from "./rules";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("roles", () => {
  it("has the eight roles, each with a label", () => {
    expect(MEMBER_ROLES).toHaveLength(8);
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...MEMBER_ROLES].sort());
    expect(ROLE_LABELS.sales_manager).toBe("Sales Manager");
  });

  it("lets only an owner create branches, invite members, rename the product and switch modules", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "branch.create")).toBe(role === "owner");
      expect(can(role, "member.invite")).toBe(role === "owner");
      expect(can(role, "branding.update")).toBe(role === "owner");
      expect(can(role, "module.update")).toBe(role === "owner");
    }
  });

  it("opens settings and the member list to an owner and an auditor, nobody else", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "settings.read")).toBe(role === "owner" || role === "auditor");
      expect(can(role, "member.read")).toBe(role === "owner" || role === "auditor");
    }
  });

  it("lets an owner and an auditor read the audit log, nobody else", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "audit.read")).toBe(role === "owner" || role === "auditor");
    }
  });

  it("shows the tax rates to an owner, an accountant and an auditor; only the first two change them", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "tax.read")).toBe(role === "owner" || role === "accountant" || role === "auditor");
      expect(can(role, "tax.manage")).toBe(role === "owner" || role === "accountant");
    }
  });
});

describe("branch scope", () => {
  it("treats null as every branch", () => {
    expect(seesBranch(null, A)).toBe(true);
  });

  it("limits a list to its branches", () => {
    expect(seesBranch([A], A)).toBe(true);
    expect(seesBranch([A], B)).toBe(false);
  });

  it("treats an empty list as no branch", () => {
    expect(seesBranch([], A)).toBe(false);
  });
});

describe("resolveActiveMembership", () => {
  const older = { tenantId: A, active: true, createdAt: new Date("2026-01-01") };
  const newer = { tenantId: B, active: true, createdAt: new Date("2026-06-01") };
  const inactive = { tenantId: C, active: false, createdAt: new Date("2025-01-01") };

  it("returns null when the user has no active membership", () => {
    expect(resolveActiveMembership([], A)).toBeNull();
    expect(resolveActiveMembership([inactive], C)).toBeNull();
  });

  it("uses the preferred tenant when the user is an active member of it", () => {
    expect(resolveActiveMembership([older, newer], B)).toBe(newer);
  });

  it("ignores a preferred tenant the user does not belong to", () => {
    expect(resolveActiveMembership([older, newer], C)).toBe(older);
  });

  it("ignores a preferred tenant where the membership is inactive", () => {
    expect(resolveActiveMembership([newer, inactive], C)).toBe(newer);
  });

  it("falls back to the oldest active membership", () => {
    expect(resolveActiveMembership([newer, older], null)).toBe(older);
  });
});

describe("input schemas", () => {
  it("trims and lower-cases an email", () => {
    expect(emailSchema.parse("  Owner@Example.COM ")).toBe("owner@example.com");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("requires a company name of at least two characters", () => {
    expect(companyNameSchema.parse("  Alpha Motors ")).toBe("Alpha Motors");
    expect(companyNameSchema.safeParse(" A ").success).toBe(false);
  });

  it("requires a new password of ten characters, typed twice the same", () => {
    expect(newPasswordSchema.safeParse({ password: "short", confirm: "short" }).success).toBe(false);
    expect(newPasswordSchema.safeParse({ password: "long-enough-1", confirm: "different-1" }).success).toBe(false);
    expect(newPasswordSchema.safeParse({ password: "long-enough-1", confirm: "long-enough-1" }).success).toBe(true);
  });

  it("accepts an invite for every branch or for chosen branches", () => {
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "salesperson", branchIds: null }).success).toBe(true);
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "salesperson", branchIds: [A] }).success).toBe(true);
  });

  it("refuses an invite with an empty branch list, an unknown role or a bad branch id", () => {
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "salesperson", branchIds: [] }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "admin", branchIds: null }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "auditor", branchIds: ["x"] }).success).toBe(false);
  });

  it("refuses to limit an owner to some branches", () => {
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "owner", branchIds: [A] }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@example.com", role: "owner", branchIds: null }).success).toBe(true);
  });
});

const labels = (entries: { label: string }[]) => entries.map((e) => e.label);
const state = (changes: Partial<Record<ModuleKey, boolean>> = {}) => resolveModules(changes);

describe("modules", () => {
  it("starts a company with the trading modules on, and payroll and FBR off", () => {
    expect(state()).toEqual({
      sales: true,
      collections: true,
      purchasing: true,
      imports: true,
      inventory: true,
      cash_bank: true,
      commissions: true,
      payroll: false,
      fbr: false,
    });
  });

  it("keeps the company's own choice over the default", () => {
    expect(state({ payroll: true, commissions: false })).toMatchObject({ payroll: true, commissions: false, sales: true });
  });

  it("has defaults that obey the dependency rules", () => {
    const defaults = state();
    for (const key of MODULES) {
      if (!defaults[key]) continue;
      for (const needed of MODULE_INFO[key].requires) expect(defaults[needed], `${key} needs ${needed}`).toBe(true);
    }
  });

  it("never lets a module require itself or an unknown module", () => {
    for (const key of MODULES) {
      expect(MODULE_INFO[key].requires).not.toContain(key);
      for (const needed of MODULE_INFO[key].requires) expect(MODULES).toContain(needed);
    }
  });

  it("turns a module on when everything it needs is on", () => {
    expect(checkModuleChange(state(), "fbr", true)).toEqual({ ok: true });
    expect(checkModuleChange(state(), "payroll", true)).toEqual({ ok: true });
  });

  it("refuses to turn a module on while something it needs is off", () => {
    expect(checkModuleChange(state({ imports: false, purchasing: false }), "imports", true)).toEqual({
      ok: false,
      reason: "Turn on Purchases first. Imports needs it.",
    });
    expect(checkModuleChange(state({ commissions: false, collections: false, sales: false }), "commissions", true)).toEqual({
      ok: false,
      reason: "Turn on Sales and Collections first. Commissions needs it.",
    });
  });

  it("turns a module off when nothing that is on needs it", () => {
    expect(checkModuleChange(state(), "commissions", false)).toEqual({ ok: true });
    expect(checkModuleChange(state({ imports: false }), "purchasing", false)).toEqual({ ok: true });
  });

  it("refuses to turn a module off while something that is on needs it", () => {
    expect(checkModuleChange(state(), "purchasing", false)).toEqual({
      ok: false,
      reason: "Turn off Imports first. It needs Purchases.",
    });
    expect(checkModuleChange(state({ fbr: true }), "sales", false)).toEqual({
      ok: false,
      reason: "Turn off Collections, Commissions and FBR digital invoicing first. It needs Sales.",
    });
  });
});

describe("navigation", () => {
  it("starts every role's menu with Home and Needs attention", () => {
    for (const role of MEMBER_ROLES) {
      expect(navFor(role, state()).slice(0, 2)).toEqual([
        { label: "Home", href: "/" },
        { label: "Needs attention", href: "/inbox" },
      ]);
    }
  });

  it("gives the owner the whole business and Settings", () => {
    expect(labels(navFor("owner", state()))).toEqual([
      "Home",
      "Needs attention",
      "Sales",
      "Collections",
      "Purchases and imports",
      "Stock",
      "Cash and bank",
      "Commissions",
      "Reports",
      "Settings",
    ]);
    expect(navFor("owner", state()).find((e) => e.label === "Settings")?.href).toBe("/settings");
  });

  it("gives each working role its own short menu", () => {
    expect(labels(navFor("salesperson", state()))).toEqual(["Home", "Needs attention", "My customers", "Orders", "My commission"]);
    expect(labels(navFor("recovery_officer", state()))).toEqual([
      "Home",
      "Needs attention",
      "Cheques",
      "Overdue customers",
      "Follow-ups",
      "Receipts",
      "Customer statements",
    ]);
    expect(labels(navFor("warehouse_manager", state()))).toEqual([
      "Home",
      "Needs attention",
      "Receive goods",
      "Deliveries",
      "Transfers",
      "Stock",
      "Stock count",
    ]);
    expect(labels(navFor("payroll_administrator", state({ payroll: true })))).toEqual([
      "Home",
      "Needs attention",
      "Employees",
      "Payroll runs",
      "Payslips",
    ]);
  });

  it("gives the accountant the books, the exchange rates and the tax rates", () => {
    const menu = navFor("accountant", state());
    expect(labels(menu)).toEqual([
      "Home",
      "Needs attention",
      "Sales invoices",
      "Bills and payments",
      "Bank and cash",
      "Journals",
      "Period close",
      "Reports",
      "Exchange rates",
      "Tax rates",
    ]);
    expect(menu.find((e) => e.label === "Exchange rates")?.href).toBe("/settings/currencies");
    expect(menu.find((e) => e.label === "Tax rates")?.href).toBe("/settings/tax");
  });

  it("removes a module's entries when the module is off", () => {
    expect(labels(navFor("owner", state({ commissions: false })))).not.toContain("Commissions");
    expect(labels(navFor("salesperson", state({ commissions: false })))).toEqual(["Home", "Needs attention", "My customers", "Orders"]);
    expect(labels(navFor("payroll_administrator", state()))).toEqual(["Home", "Needs attention"]);
    expect(labels(navFor("owner", state({ payroll: true })))).toContain("Payroll");
  });

  it("names purchases by whether imports is on", () => {
    expect(labels(navFor("owner", state({ imports: false })))).toContain("Purchases");
    expect(labels(navFor("owner", state({ imports: false })))).not.toContain("Purchases and imports");
  });

  it("shows Settings only to an owner and an auditor", () => {
    for (const role of MEMBER_ROLES) {
      expect(labels(navFor(role, state())).includes("Settings")).toBe(role === "owner" || role === "auditor");
    }
  });
});

describe("branding", () => {
  it("trims the product name and refuses an empty or very long one", () => {
    expect(productNameSchema.parse("  Karachi Parts Desk ")).toBe("Karachi Parts Desk");
    expect(productNameSchema.safeParse("   ").success).toBe(false);
    expect(productNameSchema.safeParse("x".repeat(61)).success).toBe(false);
  });

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("accepts a PNG, JPEG or WebP by its contents", () => {
    expect(checkLogo(png)).toEqual({ ok: true, contentType: "image/png" });
    expect(checkLogo(jpeg)).toEqual({ ok: true, contentType: "image/jpeg" });
    expect(checkLogo(webp)).toEqual({ ok: true, contentType: "image/webp" });
  });

  it("refuses anything else, whatever it is called", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const gif = new TextEncoder().encode("GIF89a");
    expect(checkLogo(svg)).toEqual({ ok: false, reason: "Use a PNG, JPEG or WebP image." });
    expect(checkLogo(gif)).toEqual({ ok: false, reason: "Use a PNG, JPEG or WebP image." });
    expect(checkLogo(new Uint8Array())).toEqual({ ok: false, reason: "Choose an image file." });
  });

  it("refuses a logo over 256 KB", () => {
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set(png);
    expect(checkLogo(big)).toEqual({ ok: false, reason: "The logo must be 256 KB or smaller." });
  });
});
