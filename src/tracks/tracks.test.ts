import { describe, expect, it } from "vitest";
import { CONTROL_TYPES, CORE_CONTROL_TYPES } from "@/modules/ledger/rules";
import { CORE_DOCUMENT_TYPES, DOCUMENT_TYPES } from "@/modules/numbering/rules";
import { CORE_PERMISSIONS, MEMBER_ROLES, MODULES, can, navFor, resolveModules, type Permission } from "@/modules/tenant/rules";
import { TRACKS, reportsFor } from "./index";
import type { ReportSection } from "./shape";

// The three tracks add to lists the whole app shares, each in its own file. Two people who have
// never seen each other's work must not end up using the same name for two different things:
// in a merged list the second would silently replace the first. These tests are what catches
// that when the tracks are brought together.

const tracks = Object.entries(TRACKS);
const lists = ["permissions", "links", "controls", "documents"] as const;

/** Every name in a list, with the tracks that use it. */
function owners(list: (typeof lists)[number]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [name, track] of tracks) for (const key of Object.keys(track[list])) found.set(key, [...(found.get(key) ?? []), name]);
  return found;
}

describe("what the three tracks add to the shared lists", () => {
  it.each(lists)("uses no name twice in %s", (list) => {
    const twice = [...owners(list)].filter(([, who]) => who.length > 1).map(([key, who]) => `${key} (${who.join(", ")})`);
    expect(twice).toEqual([]);
  });

  // A track's list is laid over the app's own, so a name the app already uses would be replaced
  // by the track's meaning of it, for everyone, without a word.
  it("uses no name the steps before the tracks already use", () => {
    const core = { permissions: CORE_PERMISSIONS, controls: CORE_CONTROL_TYPES, documents: CORE_DOCUMENT_TYPES };
    for (const [list, own] of Object.entries(core) as [keyof typeof core, object][]) {
      const taken = [...owners(list).keys()].filter((key) => Object.hasOwn(own, key));
      expect(taken, list).toEqual([]);
    }
  });

  it("names its permissions like the rest and gives each to a real role", () => {
    for (const [name, track] of tracks) {
      for (const [permission, roles] of Object.entries(track.permissions) as [string, readonly string[]][]) {
        expect(permission, name).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
        expect(roles.length, permission).toBeGreaterThan(0);
        for (const role of roles) expect(MEMBER_ROLES, permission).toContain(role);
        // Asked through can(), the permission is held by exactly the roles the track gave it.
        for (const role of MEMBER_ROLES) expect(can(role, permission as Permission), `${permission} for ${role}`).toBe(roles.includes(role));
      }
    }
  });

  it("leads each menu entry to a screen of the app, or nowhere yet", () => {
    for (const [name, track] of tracks) {
      for (const [key, href] of Object.entries(track.links) as [string, string | null][]) {
        if (href !== null) expect(href, `${name}.${key}`).toMatch(/^\/[a-z0-9/?=&_-]*$/);
      }
    }
    // Every role still gets its menu, with Home first.
    for (const role of MEMBER_ROLES) expect(navFor(role, resolveModules({}))[0]).toEqual({ label: "Home", href: "/" });
  });

  it("names its locked accounts and document kinds the way the database expects", () => {
    for (const [name, track] of tracks) {
      for (const [control, label] of Object.entries(track.controls) as [string, string][]) {
        expect(control, name).toMatch(/^[a-z_]{2,40}$/);
        expect(CONTROL_TYPES[control as keyof typeof CONTROL_TYPES], control).toBe(label);
      }
      for (const [letters, label] of Object.entries(track.documents) as [string, string][]) {
        expect(letters, name).toMatch(/^[A-Z]{2}$/);
        expect(DOCUMENT_TYPES[letters as keyof typeof DOCUMENT_TYPES], letters).toBe(label);
      }
    }
  });

  it("lists each report once, behind a permission that exists", () => {
    const all = tracks.flatMap(([, track]) => track.reports.flatMap((section) => section.reports));
    expect(new Set(all.map((report) => report.href)).size).toBe(all.length);
    for (const report of all) {
      expect(report.href).toMatch(/^\/[a-z0-9/?=&_-]+$/);
      expect(MEMBER_ROLES.some((role) => can(role, report.permission)), report.href).toBe(true);
      if (report.module !== undefined) expect(MODULES).toContain(report.module);
    }
  });

  it("shows a role only the reports it may open, and no empty heading", () => {
    const sections: ReportSection[] = [
      {
        title: "Customers",
        reports: [
          { label: "Sales documents", href: "/reports/zz-sales", about: "x", permission: "sales.read", module: "sales" },
          { label: "The ledger", href: "/reports/zz-ledger", about: "x", permission: "report.read" },
        ],
      },
      { title: "Owner only", reports: [{ label: "Credit", href: "/reports/zz-credit", about: "x", permission: "sales.approve_credit" }] },
    ];
    const on = resolveModules({});
    const titles = (found: ReportSection[]) => found.map((section) => `${section.title}: ${section.reports.map((report) => report.label).join(", ")}`);
    expect(titles(reportsFor("owner", on, sections))).toEqual(["Customers: Sales documents, The ledger", "Owner only: Credit"]);
    expect(titles(reportsFor("salesperson", on, sections))).toEqual(["Customers: Sales documents"]);
    expect(titles(reportsFor("warehouse_manager", on, sections))).toEqual([]);
    // A module that is off takes its reports with it.
    expect(titles(reportsFor("salesperson", { ...on, sales: false }, sections))).toEqual([]);
  });
});
