// One function per kind of job. A handler gets the job row and may be run more than once for the
// same job (after a failure, or if a worker stopped mid-way), so it must be safe to repeat.
// What it returns is stored as the job's result; what it throws is stored as the error.

export const handlers = {
  /** Does nothing. Queue one to check that the worker is alive. */
  "system.ping": async () => ({ pong: true }),
};
