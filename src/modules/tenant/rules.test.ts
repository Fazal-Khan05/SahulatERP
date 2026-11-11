import { describe, expect, it } from "vitest";
import {
  MEMBER_ROLES,
  ROLE_LABELS,
  can,
  companyNameSchema,
  emailSchema,
  inviteSchema,
  newPasswordSchema,
  resolveActiveMembership,
  seesBranch,
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

  it("lets only an owner create branches and invite members", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "branch.create")).toBe(role === "owner");
      expect(can(role, "member.invite")).toBe(role === "owner");
      expect(can(role, "member.read")).toBe(role === "owner");
    }
  });

  it("lets an owner and an auditor read the audit log, nobody else", () => {
    for (const role of MEMBER_ROLES) {
      expect(can(role, "audit.read")).toBe(role === "owner" || role === "auditor");
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
