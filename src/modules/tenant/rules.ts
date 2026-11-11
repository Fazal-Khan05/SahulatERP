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
  "branch.create": ["owner"],
  "member.read": ["owner"],
  "member.invite": ["owner"],
  "audit.read": ["owner", "auditor"],
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
