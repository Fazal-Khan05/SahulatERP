import { describe, expect, it } from "vitest";
import { passwordSchema, passwordUsesEmail } from "@/modules/tenant/rules";
import { readLastActive, signLastActive } from "./activity-cookie";
import {
  FRESH_SIGN_IN_SECONDS,
  IDLE_MINUTES,
  MAX_SESSION_HOURS,
  RECENT_SIGN_IN_MINUTES,
  cleanCode,
  clientAddressOf,
  deviceOf,
  idleTooLong,
  proofsOf,
  provedRecently,
  sessionTooOld,
  twoStepGate,
  twoStepRequiredFor,
} from "./rules";

const NOW = 1_800_000_000;

describe("two-step sign-in", () => {
  it("is asked of owners and accountants only", () => {
    expect(twoStepRequiredFor("owner")).toBe(true);
    expect(twoStepRequiredFor("accountant")).toBe(true);
    for (const role of ["sales_manager", "salesperson", "recovery_officer", "warehouse_manager", "payroll_administrator", "auditor"] as const) {
      expect(twoStepRequiredFor(role)).toBe(false);
    }
  });

  it("asks for the code of anyone with an app, and the setup of anyone who must have one", () => {
    expect(twoStepGate({ level: "aal2", hasFactor: true, required: true })).toBe("ok");
    expect(twoStepGate({ level: "aal1", hasFactor: true, required: false })).toBe("code");
    expect(twoStepGate({ level: "aal1", hasFactor: true, required: true })).toBe("code");
    expect(twoStepGate({ level: "aal1", hasFactor: false, required: true })).toBe("setup");
    expect(twoStepGate({ level: "aal1", hasFactor: false, required: false })).toBe("ok");
    // A token with no level is not taken as having given a code.
    expect(twoStepGate({ level: undefined, hasFactor: true, required: false })).toBe("code");
  });

  it("takes a six-digit code, spaces allowed, and nothing else", () => {
    expect(cleanCode("123456")).toBe("123456");
    expect(cleanCode(" 123 456 ")).toBe("123456");
    expect(cleanCode("12345")).toBeNull();
    expect(cleanCode("1234567")).toBeNull();
    expect(cleanCode("12345a")).toBeNull();
    expect(cleanCode(null)).toBeNull();
  });
});

describe("session limits", () => {
  const signedIn = (secondsAgo: number) => [{ method: "password", timestamp: NOW - secondsAgo }];

  it("reads the token's proofs and leaves out anything malformed", () => {
    expect(proofsOf([{ method: "password", timestamp: 5 }, { method: "totp" }, "otp", null, { method: 3, timestamp: 4 }])).toEqual([
      { method: "password", timestamp: 5 },
    ]);
    expect(proofsOf(undefined)).toEqual([]);
    expect(proofsOf("password")).toEqual([]);
  });

  it(`ends a session ${MAX_SESSION_HOURS} hours after the password, however busy`, () => {
    expect(sessionTooOld(signedIn(MAX_SESSION_HOURS * 3600), NOW)).toBe(false);
    expect(sessionTooOld(signedIn(MAX_SESSION_HOURS * 3600 + 1), NOW)).toBe(true);
    // A code given later does not make the session younger.
    expect(sessionTooOld([...signedIn(MAX_SESSION_HOURS * 3600 + 1), { method: "totp", timestamp: NOW }], NOW)).toBe(true);
    // A token that says nothing of how it was proven is not trusted to be young.
    expect(sessionTooOld([], NOW)).toBe(true);
  });

  it(`ends a session left for more than ${IDLE_MINUTES} minutes`, () => {
    const morning = signedIn(5 * 3600);
    expect(idleTooLong(NOW - IDLE_MINUTES * 60, morning, NOW)).toBe(false);
    expect(idleTooLong(NOW - IDLE_MINUTES * 60 - 1, morning, NOW)).toBe(true);
  });

  it("takes a session with no trustworthy record of its last use as idle, unless it was just signed in", () => {
    expect(idleTooLong(null, signedIn(FRESH_SIGN_IN_SECONDS), NOW)).toBe(false);
    expect(idleTooLong(null, signedIn(FRESH_SIGN_IN_SECONDS + 1), NOW)).toBe(true);
    // A code given just now does not count as just signed in.
    expect(idleTooLong(null, [...signedIn(3600), { method: "totp", timestamp: NOW }], NOW)).toBe(true);
    expect(idleTooLong(null, [], NOW)).toBe(true);
  });

  it(`lets the password change without the old one only within ${RECENT_SIGN_IN_MINUTES} minutes of a proof`, () => {
    expect(provedRecently(signedIn(RECENT_SIGN_IN_MINUTES * 60), NOW)).toBe(true);
    expect(provedRecently(signedIn(RECENT_SIGN_IN_MINUTES * 60 + 1), NOW)).toBe(false);
    // A code is not a proof of who is at the keyboard for this: anyone holding an old session of a
    // member without an app could set up one of their own and give its code.
    expect(provedRecently([...signedIn(5 * 3600), { method: "totp", timestamp: NOW - 60 }], NOW)).toBe(false);
    // An email link is.
    expect(provedRecently([...signedIn(5 * 3600), { method: "otp", timestamp: NOW - 60 }], NOW)).toBe(true);
    expect(provedRecently([], NOW)).toBe(false);
  });
});

describe("the password policy", () => {
  const ok = (p: string) => passwordSchema.safeParse(p).success;

  it("asks for length, not kinds of character", () => {
    expect(ok("correct horse battery")).toBe(true);
    expect(ok("short pass1")).toBe(false);
    expect(ok("x".repeat(73))).toBe(false);
  });

  it("refuses a few characters over and over, the most used passwords and the product's name", () => {
    expect(ok("abababababababab")).toBe(false);
    expect(ok("Password1234")).toBe(false);
    expect(ok("pakistan1234")).toBe(false);
    expect(ok("my SahulatERP pass")).toBe(false);
  });

  it("refuses the name part of the member's own email", () => {
    expect(passwordUsesEmail("bilal.traders-2026", "bilal.traders@example.com")).toBe(true);
    expect(passwordUsesEmail("something else entirely", "bilal.traders@example.com")).toBe(false);
    // Too short a name to mean anything.
    expect(passwordUsesEmail("ali is my friend", "ali@example.com")).toBe(false);
  });
});

describe("the sign-in history", () => {
  it("names the browser and the system, coarsely", () => {
    expect(
      deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"),
    ).toBe("Chrome on Windows");
    expect(
      deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    ).toBe("Safari on Mac");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe(
      "Chrome on Android",
    );
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe(
      "Edge on Windows",
    );
    expect(deviceOf(null)).toBe("Unknown device");
  });

  it("keeps the first address the network gives, if it is one", () => {
    expect(clientAddressOf("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(clientAddressOf("2001:db8::1")).toBe("2001:db8::1");
    expect(clientAddressOf("<script>")).toBeNull();
    expect(clientAddressOf(undefined)).toBeNull();
  });
});

describe("the idle-time cookie", () => {
  const SECRET = "ab".repeat(32);
  const SESSION = "6f1f8c1e-0000-4000-8000-000000000001";

  it("is read back only for the session it was signed for, unchanged, and not from the future", () => {
    const value = signLastActive(NOW - 100, SESSION, SECRET);
    expect(readLastActive(value, SESSION, NOW, SECRET)).toBe(NOW - 100);
    expect(readLastActive(value, "6f1f8c1e-0000-4000-8000-000000000002", NOW, SECRET)).toBeNull();
    const moved = value.replace(String(NOW - 100), String(NOW - 10));
    expect(readLastActive(moved, SESSION, NOW, SECRET)).toBeNull();
    expect(readLastActive(String(NOW), SESSION, NOW, SECRET)).toBeNull();
    expect(readLastActive(signLastActive(NOW + 3600, SESSION, SECRET), SESSION, NOW, SECRET)).toBeNull();
    expect(readLastActive(undefined, SESSION, NOW, SECRET)).toBeNull();
    expect(readLastActive(signLastActive(NOW, SESSION, "cd".repeat(32)), SESSION, NOW, SECRET)).toBeNull();
  });

  it("is a plain time where no secret is set (a local database)", () => {
    expect(signLastActive(NOW, SESSION, "")).toBe(String(NOW));
    expect(readLastActive(String(NOW - 5), SESSION, NOW, "")).toBe(NOW - 5);
    expect(readLastActive("soon", SESSION, NOW, "")).toBeNull();
  });
});
