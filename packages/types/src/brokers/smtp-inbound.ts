import { z } from 'zod'

/**
 * The `smtp-inbound` broker kind (D999): a mailbox a device can send mail to.
 *
 * The `broker` cap carries these as `Record<string, unknown>` on the wire; the
 * provider and its consumers parse them with the schemas below at BOTH ends, so
 * the shape is declared once.
 */

/** The broker kind tag. */
export const SMTP_INBOUND_KIND = 'smtp-inbound'

/** The id the first mailbox is minted under (adopt-id), so a consumer can find it again. */
export const SMTP_INBOUND_DEFAULT_ID = 'smtp-inbound-default'

export const SMTP_INBOUND_DEFAULT_PORT = 2525
export const SMTP_INBOUND_DEFAULT_DOMAIN = 'camstack.local'
export const SMTP_INBOUND_DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024
/** The ring keeps the last N messages of one mailbox, each for at most the age below. */
export const SMTP_INBOUND_RING_MAX_MESSAGES = 200
export const SMTP_INBOUND_RING_MAX_AGE_MS = 15 * 60 * 1000
/** The text excerpt a message carries on the bus. */
export const SMTP_INBOUND_TEXT_MAX_CHARS = 4096

/** Typed error codes of the kind, carried in the thrown message as a prefix. */
export const SMTP_RECIPIENT_CLAIMED = 'smtp-inbound/recipient-claimed'

const PortSchema = z.number().int().min(1).max(65535)

/** A recipient local-part: what stands before the `@`. */
export const SmtpRecipientSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._+-]+$/)

export const SmtpInboundSettingsSchema = z.object({
  port: PortSchema.default(SMTP_INBOUND_DEFAULT_PORT),
  bindHost: z.string().min(1).default('0.0.0.0'),
  domain: z.string().min(1).default(SMTP_INBOUND_DEFAULT_DOMAIN),
  requireAuth: z.boolean().default(true),
  username: z.string().default(''),
  password: z.string().default('').meta({ secret: true }),
  starttls: z.boolean().default(false),
  maxMessageBytes: z.number().int().positive().default(SMTP_INBOUND_DEFAULT_MAX_MESSAGE_BYTES),
})
export type SmtpInboundSettings = z.infer<typeof SmtpInboundSettingsSchema>

/**
 * What `getBrokerConfig` answers: what a device needs to send mail here.
 * `host` is null when the `internal` role of the network palette is not set;
 * `hostReason` then says where to set it.
 */
export const SmtpInboundConfigSchema = z.object({
  host: z.string().min(1).nullable(),
  hostReason: z.string().nullable(),
  port: PortSchema,
  domain: z.string().min(1),
  requireAuth: z.boolean(),
  username: z.string(),
  password: z.string(),
  starttls: z.boolean(),
})
export type SmtpInboundConfig = z.infer<typeof SmtpInboundConfigSchema>

export const SmtpInboundFilterSchema = z.object({
  recipients: z.array(SmtpRecipientSchema).min(1),
  /**
   * Who is subscribing. A second `subscribe` with the same id REPLACES that subscriber's
   * recipients (the way a consumer that restarted, or lost a device, declares its set again);
   * a recipient held by another subscriber is refused with `smtp-inbound/recipient-claimed`.
   * Absent, the subscriber is anonymous and unique.
   */
  subscriberId: z.string().min(1).max(64).optional(),
})
export type SmtpInboundFilter = z.infer<typeof SmtpInboundFilterSchema>

export const SmtpInboundAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
})

/** The payload of one `broker.message` (the key is the recipient local-part). */
export const SmtpInboundMessageSchema = z.object({
  /** Monotonic per mailbox; a gap tells a consumer it missed an event. */
  seq: z.number().int().positive(),
  messageId: z.string(),
  receivedAt: z.number().int().nonnegative(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  text: z.string().max(SMTP_INBOUND_TEXT_MAX_CHARS),
  attachments: z.array(SmtpInboundAttachmentSchema),
})
export type SmtpInboundMessage = z.infer<typeof SmtpInboundMessageSchema>

/** What `getState('since:<seq>')` answers: every retained message after `seq`. */
export const SmtpInboundSinceSchema = z.object({
  /** The newest seq issued so far (0 before any mail). */
  lastSeq: z.number().int().nonnegative(),
  /** The oldest seq still retained; messages below it are gone. */
  oldestSeq: z.number().int().nonnegative(),
  messages: z.array(z.object({ key: z.string(), message: SmtpInboundMessageSchema })),
})
export type SmtpInboundSince = z.infer<typeof SmtpInboundSinceSchema>

/** The key a consumer passes to `getState` to replay the ring, and its parser. */
export function smtpSinceKey(seq: number): string {
  return `since:${seq}`
}
const SINCE_RE = /^since:(\d+)$/
export function parseSmtpSinceKey(key: string): number | null {
  const match = SINCE_RE.exec(key)
  return match?.[1] === undefined ? null : Number(match[1])
}
