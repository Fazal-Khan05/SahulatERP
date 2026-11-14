import "server-only";
import type { MailSender } from "./rules";

/**
 * The email service this deployment sends through, or null when none is set up.
 *
 * None is chosen yet: on 2026-11-14 the founder chose to decide the provider later
 * (docs/later/step-23.md). Until then every email is refused with "Email is not set up yet",
 * before anything is written. Adding a provider means writing a MailSender for it here, reading
 * its key from the environment, and nothing else.
 */
export function mailSenderFromEnvironment(): MailSender | null {
  return null;
}
