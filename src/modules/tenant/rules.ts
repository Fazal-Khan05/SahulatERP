import { z } from "zod";

// Pure rules for tenants, memberships and branch scope. No I/O.

export const MEMBER_ROLES = [
  "owner",
  "accountant",
  "sales_manager",
  "salesperson",
  "recovery_officer",
  "warehouse_manager",
  "payroll_administrator",
  "auditor",
] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  accountant: "Accountant",
  sales_manager: "Sales Manager",
  salesperson: "Salesperson",
  recovery_officer: "Recovery Officer",
  warehouse_manager: "Warehouse Manager",
  payroll_administrator: "Payroll Administrator",
  auditor: "Auditor",
};

// Who may do what. The database policies enforce the same split; this table decides what the
// screens offer and gives a clear refusal before a query is attempted.
const PERMISSIONS = {
  "settings.read": ["owner", "auditor"],
  "branding.update": ["owner"],
  "module.update": ["owner"],
  "branch.create": ["owner"],
  "member.read": ["owner", "auditor"],
  "member.invite": ["owner"],
  "audit.read": ["owner", "auditor"],
  "file.read": ["owner", "auditor"],
  "file.upload": ["owner"],
  "currency.read": ["owner", "accountant", "auditor"],
  "currency.manage": ["owner", "accountant"],
  "currency.set_base": ["owner"],
  "tax.read": ["owner", "accountant", "auditor"],
  "tax.manage": ["owner", "accountant"],
  "customer.read": ["owner", "accountant", "auditor", "sales_manager", "salesperson", "recovery_officer"],
  "customer.manage": ["owner", "accountant", "sales_manager"],
  "supplier.read": ["owner", "accountant", "auditor", "warehouse_manager"],
  "supplier.manage": ["owner", "accountant"],
  "item.read": ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"],
  "item.manage": ["owner", "accountant"],
  "price.read": ["owner", "accountant", "auditor", "sales_manager", "salesperson"],
  "price.manage": ["owner", "accountant", "sales_manager"],
  "warehouse.create": ["owner"],
  "setup.complete": ["owner"],
  "period.read": ["owner", "accountant", "auditor"],
  "period.manage": ["owner"],
  "account.read": ["owner", "accountant", "auditor"],
  "account.manage": ["owner", "accountant"],
  "account.seed": ["owner"],
  "journal.read": ["owner", "accountant", "auditor"],
  "journal.manage": ["owner", "accountant"],
  "opening.read": ["owner", "accountant", "auditor"],
  "opening.manage": ["owner", "accountant"],
  "report.read": ["owner", "accountant", "auditor"],
} as const satisfies Record<string, readonly MemberRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: MemberRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly MemberRole[]).includes(role);
}

/** `null` means every branch; a list means only those branches; an empty list means none. */
export type BranchScope = readonly string[] | null;

export function seesBranch(scope: BranchScope, branchId: string): boolean {
  return scope === null || scope.includes(branchId);
}

export type MembershipSummary = {
  tenantId: string;
  tenantName: string;
  role: MemberRole;
  branchIds: string[] | null;
  active: boolean;
  createdAt: Date;
};

/** Who is asking and for which company. Built from the verified session, never from the request. */
export type TenantContext = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  role: MemberRole;
  branchIds: string[] | null;
};

/**
 * The membership a request runs under: the preferred tenant if the user is still an active member
 * of it, otherwise their oldest active membership. A tenant id the user does not belong to is
 * ignored, never trusted.
 */
export function resolveActiveMembership<M extends Pick<MembershipSummary, "tenantId" | "active" | "createdAt">>(
  memberships: readonly M[],
  preferredTenantId: string | null | undefined,
): M | null {
  const active = memberships.filter((m) => m.active);
  if (active.length === 0) return null;
  const preferred = active.find((m) => m.tenantId === preferredTenantId);
  if (preferred) return preferred;
  return [...active].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address.").max(254));

// Supabase Auth enforces the same minimum; 72 bytes is the bcrypt limit.
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(72, "Use at most 72 characters.");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The two passwords do not match.", path: ["confirm"] });

export const companyNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the company name.")
  .max(120, "Use at most 120 characters.");

export const branchNameSchema = z
  .string()
  .trim()
  .min(1, "Enter the branch name.")
  .max(80, "Use at most 80 characters.");

export const inviteSchema = z
  .object({
    email: emailSchema,
    role: z.enum(MEMBER_ROLES, "Choose a role."),
    // null = every branch.
    branchIds: z.array(z.uuid()).min(1, "Choose at least one branch, or all branches.").nullable(),
  })
  .refine((v) => v.role !== "owner" || v.branchIds === null, {
    message: "An owner always has every branch.",
    path: ["branchIds"],
  });

export type InviteInput = z.infer<typeof inviteSchema>;

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

// ── Modules ─────────────────────────────────────────────────────────────────────────────────────
// A company switches whole areas of the product on or off. A module that is off is invisible:
// no menu entry, no column, no report section.

export const MODULES = [
  "sales",
  "collections",
  "purchasing",
  "imports",
  "inventory",
  "cash_bank",
  "commissions",
  "payroll",
  "fbr",
] as const;

export type ModuleKey = (typeof MODULES)[number];
export type ModuleState = Record<ModuleKey, boolean>;

type ModuleInfo = {
  label: string;
  about: string;
  /** Modules that must be on for this one to work. */
  requires: readonly ModuleKey[];
  /** The state of a company that has never touched the switch. */
  onByDefault: boolean;
};

export const MODULE_INFO: Record<ModuleKey, ModuleInfo> = {
  sales: {
    label: "Sales",
    about: "Quotations, orders, deliveries, invoices and returns.",
    requires: ["inventory"],
    onByDefault: true,
  },
  collections: {
    label: "Collections",
    about: "Receipts, cheques, follow-ups and customer statements.",
    requires: ["sales", "cash_bank"],
    onByDefault: true,
  },
  purchasing: {
    label: "Purchases",
    about: "Purchase orders, goods received, supplier bills and payments.",
    requires: ["inventory"],
    onByDefault: true,
  },
  imports: {
    label: "Imports",
    about: "Shipments, customs charges and landed cost.",
    requires: ["purchasing"],
    onByDefault: true,
  },
  inventory: {
    label: "Stock",
    about: "Stock in each warehouse, transfers, counts and valuation.",
    requires: [],
    onByDefault: true,
  },
  cash_bank: {
    label: "Cash and bank",
    about: "Bank and cash accounts, expenses, transfers and reconciliation.",
    requires: [],
    onByDefault: true,
  },
  commissions: {
    label: "Commissions",
    about: "Commission plans, accruals, releases on collection and statements.",
    requires: ["sales", "collections"],
    onByDefault: true,
  },
  payroll: {
    label: "Payroll",
    about: "Employees, payroll runs, payslips and statutory deductions.",
    requires: [],
    onByDefault: false,
  },
  fbr: {
    label: "FBR digital invoicing",
    about: "Sends sales invoices to FBR and prints the FBR number and QR code.",
    requires: ["sales"],
    onByDefault: false,
  },
};

/** The state of every module: the company's own choice where it made one, the default otherwise. */
export function resolveModules(choices: Partial<Record<ModuleKey, boolean>>): ModuleState {
  return Object.fromEntries(MODULES.map((key) => [key, choices[key] ?? MODULE_INFO[key].onByDefault])) as ModuleState;
}

function listLabels(keys: readonly ModuleKey[]): string {
  const labels = keys.map((key) => MODULE_INFO[key].label);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * The dependency rules. A module cannot be turned on while something it needs is off, and cannot
 * be turned off while something that needs it is on. Nothing is switched for the owner behind
 * their back; the refusal says what to change first.
 */
export function checkModuleChange(
  state: ModuleState,
  key: ModuleKey,
  enabled: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (enabled) {
    const missing = MODULE_INFO[key].requires.filter((needed) => !state[needed]);
    if (missing.length > 0) {
      return { ok: false, reason: `Turn on ${listLabels(missing)} first. ${MODULE_INFO[key].label} needs it.` };
    }
  } else {
    const dependants = MODULES.filter((other) => state[other] && MODULE_INFO[other].requires.includes(key));
    if (dependants.length > 0) {
      return { ok: false, reason: `Turn off ${listLabels(dependants)} first. It needs ${MODULE_INFO[key].label}.` };
    }
  }
  return { ok: true };
}

// ── Navigation ──────────────────────────────────────────────────────────────────────────────────
// Each role gets its own short menu, written in that role's words. An entry appears only while
// its module is on. `href` is null until the screen behind the entry is built.

export type NavEntry = { label: string; href: string | null };

type NavSpec = readonly [label: string, module: ModuleKey | null, href?: string];

function roleNav(role: MemberRole, on: ModuleState): readonly NavSpec[] {
  const purchases = on.imports ? "Purchases and imports" : "Purchases";
  switch (role) {
    case "owner":
      return [
        ["Sales", "sales"],
        ["Customers", "sales", "/customers"],
        ["Price lists", "sales", "/price-lists"],
        ["Collections", "collections"],
        [purchases, "purchasing"],
        ["Suppliers", "purchasing", "/suppliers"],
        ["Stock", "inventory"],
        ["Items", "inventory", "/items"],
        ["Cash and bank", "cash_bank"],
        ["Commissions", "commissions"],
        ["Payroll", "payroll"],
        ["Journals", null, "/journals"],
        ["Reports", null, "/reports"],
        ["Settings", null, "/settings"],
      ];
    case "auditor":
      return [
        ["Sales", "sales"],
        ["Customers", "sales", "/customers"],
        ["Price lists", "sales", "/price-lists"],
        ["Collections", "collections"],
        [purchases, "purchasing"],
        ["Suppliers", "purchasing", "/suppliers"],
        ["Stock", "inventory"],
        ["Items", "inventory", "/items"],
        ["Cash and bank", "cash_bank"],
        ["Commissions", "commissions"],
        ["Payroll", "payroll"],
        ["Journals", null, "/journals"],
        ["Reports", null, "/reports"],
        ["Settings", null, "/settings"],
      ];
    case "accountant":
      return [
        ["Sales invoices", "sales"],
        ["Customers", "sales", "/customers"],
        ["Price lists", "sales", "/price-lists"],
        ["Bills and payments", "purchasing"],
        ["Suppliers", "purchasing", "/suppliers"],
        ["Items", "inventory", "/items"],
        ["Bank and cash", "cash_bank"],
        ["Chart of accounts", null, "/settings/accounts"],
        ["Journals", null, "/journals"],
        ["Opening balances", null, "/settings/opening-balances"],
        ["Period close", null],
        ["Payroll", "payroll"],
        ["Reports", null, "/reports"],
        ["Exchange rates", null, "/settings/currencies"],
        ["Tax rates", null, "/settings/tax"],
      ];
    case "sales_manager":
      return [
        ["Sales", "sales"],
        ["Customers", "sales", "/customers"],
        ["Price lists", "sales", "/price-lists"],
        ["Collections", "collections"],
        ["Stock", "inventory"],
        ["Items", "inventory", "/items"],
        ["Commissions", "commissions"],
        ["Reports", null],
      ];
    case "salesperson":
      return [
        ["My customers", "sales", "/customers"],
        ["Orders", "sales"],
        ["My commission", "commissions"],
      ];
    case "recovery_officer":
      return [
        ["Cheques", "collections"],
        ["Overdue customers", "collections"],
        ["Follow-ups", "collections"],
        ["Receipts", "collections"],
        ["Customer statements", "collections"],
      ];
    case "warehouse_manager":
      return [
        ["Receive goods", "purchasing"],
        ["Deliveries", "sales"],
        ["Transfers", "inventory"],
        ["Stock", "inventory"],
        ["Items", "inventory", "/items"],
        ["Stock count", "inventory"],
      ];
    case "payroll_administrator":
      return [
        ["Employees", "payroll"],
        ["Payroll runs", "payroll"],
        ["Payslips", "payroll"],
      ];
  }
}

export function navFor(role: MemberRole, on: ModuleState): NavEntry[] {
  return [
    { label: "Home", href: "/" },
    { label: "Needs attention", href: "/inbox" },
    ...roleNav(role, on)
      .filter(([, module]) => module === null || on[module])
      .map(([label, , href]) => ({ label, href: href ?? null })),
  ];
}

// ── Branding ────────────────────────────────────────────────────────────────────────────────────

/** Shown wherever a company has not chosen its own name for the product, and before sign-in. */
export const DEFAULT_PRODUCT_NAME = "SahulatERP";

export const productNameSchema = z
  .string()
  .trim()
  .min(1, "Enter the product name.")
  .max(60, "Use at most 60 characters.");

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * Accepts a logo by what the file actually is, not by its name or the type the browser claims.
 * SVG is refused on purpose: it can carry script.
 */
export function checkLogo(bytes: Uint8Array): { ok: true; contentType: LogoType } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: "Choose an image file." };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "The logo must be 256 KB or smaller." };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, contentType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, contentType: "image/jpeg" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ok: true, contentType: "image/webp" };
  }
  return { ok: false, reason: "Use a PNG, JPEG or WebP image." };
}
