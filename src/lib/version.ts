import pkg from "../../package.json";

/**
 * The product's version as a member reads it under the sign-in box: the first two numbers of
 * `version` in package.json ("1.0.0" is shown as "1.0"). A merge to main that changes what a
 * member sees raises the second number by one; the founder says when the first changes (CLAUDE.md).
 */
export function shownVersion(version: string = pkg.version): string {
  const [major = "0", minor = "0"] = version.trim().split(".");
  return `${major}.${minor}`;
}
