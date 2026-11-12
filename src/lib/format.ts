// Dates are shown as DD-MM-YYYY, in Pakistan time until a tenant can choose its own time zone.
const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(value: Date): string {
  const parts = Object.fromEntries(dateTime.formatToParts(value).map((p) => [p.type, p.value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", weekday: "long" });

/** "Wednesday 11-11-2026". */
export function formatDay(value: Date): string {
  const parts = Object.fromEntries(dateTime.formatToParts(value).map((p) => [p.type, p.value]));
  return `${weekday.format(value)} ${parts.day}-${parts.month}-${parts.year}`;
}

const isoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today in Pakistan as YYYY-MM-DD, the form a date field and the database use. */
export function todayIso(now: Date): string {
  return isoDay.format(now);
}
