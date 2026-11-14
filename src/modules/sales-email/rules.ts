import { z } from "zod";

// Pure rules for emailing a sales document. No I/O.

export const EMAIL_STATUSES = ["sending", "sent", "failed", "unknown"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export function isEmailStatus(value: unknown): value is EmailStatus {
  return typeof value === "string" && (EMAIL_STATUSES as readonly string[]).includes(value);
}

/** One email, as it goes to the service that sends it. */
export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  /** The member who sent it, so the customer's answer reaches them. */
  replyTo: string | null;
  attachment: { filename: string; content: Uint8Array; contentType: "application/pdf" };
};

/**
 * What the service said. "unknown" is any answer that does not settle it, such as the connection
 * dropping after the message was handed over: the message may or may not be on its way.
 */
export type SendResult = { outcome: "sent"; messageId: string } | { outcome: "failed"; reason: string } | { outcome: "unknown"; reason: string };

/**
 * The service that sends email. None is chosen yet (docs/later/step-23.md): when one is, it is
 * written as one of these, and every send passes the email's own id as the idempotency key, so a
 * retry the service has already seen is not sent twice.
 */
export interface MailSender {
  /** The service's name, kept on each email. */
  readonly provider: string;
  send(email: OutgoingEmail, idempotencyKey: string): Promise<SendResult>;
  /** What became of an email sent with this key; null when the service cannot say. */
  lookup(idempotencyKey: string): Promise<SendResult | null>;
}

/** How long an email may stay "sending" before it is taken to have been interrupted. */
export const SENDING_GRACE_MS = 5 * 60 * 1000;

/** What a member typed into the email form. The document comes bound to the action, not from the form. */
export const emailFormSchema = z.object({
  to: z
    .string("Give the address to send it to.")
    .trim()
    .min(1, "Give the address to send it to.")
    .max(254, "That address is too long.")
    .pipe(z.email("That is not an email address.")),
  subject: z
    .string()
    .trim()
    .min(1, "Give the email a subject.")
    .max(200, "Keep the subject under 200 characters.")
    // One line only: a line break in a subject could add a header to the email.
    .refine((subject) => !/[\u0000-\u001f\u007f]/.test(subject), "Keep the subject on one line."),
  message: z.string().trim().min(1, "Write a short message to go with the document.").max(4000, "Keep the message under 4,000 characters."),
});
export type EmailForm = z.infer<typeof emailFormSchema>;

/** A message that the outside service's reply cannot leak into: only these words are kept. */
export function failureWords(reason: string): string {
  const clean = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (clean === "" ? "The email service refused it." : clean).slice(0, 300);
}

/** The subject and message a new email starts with; the member can change both. */
export function defaultEmail(facts: { title: string; number: string; date: string; companyName: string; customerName: string; total: string | null }): { subject: string; message: string } {
  const subject = `${facts.title} ${facts.number} from ${facts.companyName}`;
  const lines = [
    `Dear ${facts.customerName},`,
    "",
    `Please find attached our ${facts.title.toLowerCase()} ${facts.number} dated ${facts.date}${facts.total ? `, for ${facts.total}` : ""}.`,
    "",
    "Regards,",
    facts.companyName,
  ];
  return { subject: subject.slice(0, 200), message: lines.join("\n") };
}
