// Pure rules for background jobs. No I/O.
//
// A job is a row. The web app only adds rows; the worker (scripts/worker.mjs) is the only thing
// that runs them, and it is a separate process with its own credentials.

/** The kinds of job the web app may ask for. The worker refuses a kind it has no handler for. */
export const JOB_KINDS = ["system.ping"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** How many times a job is tried before it is set aside as dead. */
export const DEFAULT_MAX_ATTEMPTS = 5;

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}
