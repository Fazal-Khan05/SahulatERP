import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { shownVersion } from "./version";

describe("the version a member reads", () => {
  it("is the first two numbers of the package's version", () => {
    expect(shownVersion("1.0.0")).toBe("1.0");
    expect(shownVersion("1.1.0")).toBe("1.1");
    expect(shownVersion("1.12.3")).toBe("1.12");
    expect(shownVersion("2.0.0")).toBe("2.0");
    expect(shownVersion("3")).toBe("3.0");
  });

  it("is two whole numbers for the package as it stands", () => {
    expect(shownVersion()).toMatch(/^[1-9]\d*\.\d+$/);
    expect(shownVersion()).toBe(shownVersion(pkg.version));
  });
});
