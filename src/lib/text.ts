// Text as a person typed it, made safe to store and compare. No I/O.

/** Invisible characters dropped; control characters and runs of spaces made one space; trimmed. */
export function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .replace(/\s+/g, " ")
    : "";
}

/** Letters and digits only, lower case: how a heading or a choice is compared. */
export function plainKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const YES = new Set(["yes", "y", "true", "1", "on"]);
const NO = new Set(["", "no", "n", "false", "0", "off"]);

/** Yes or no as people write it; undefined when it is neither. Nothing typed is no. */
export function readYesNo(value: unknown): boolean | undefined {
  const word = plainKey(cleanText(value));
  return YES.has(word) ? true : NO.has(word) ? false : undefined;
}
