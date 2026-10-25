import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `smtp-provider` — pluggable email delivery surface.
 *
 * Collection cap: a deployment may install multiple SMTP relays (e.g.
 * one for transactional / one for notifications). Consumers (notifier
 * addons, …) walk the collection and pick the first
 * ready provider OR target a specific addonId.
 *
 * The shape stays small on purpose — `sendEmail` is enough for the
 * 90% case. Attachments / HTML templating / multi-part are room for
 * future fields without breaking the existing call sites.
 */

const EmailAddressSchema = z.email()

const SendEmailInputSchema = z.object({
  to: z.union([EmailAddressSchema, z.array(EmailAddressSchema).min(1)]),
  cc: z.array(EmailAddressSchema).optional(),
  bcc: z.array(EmailAddressSchema).optional(),
  /** RFC 5322 `From` field. Most relays will reject if the domain
   *  isn't authorised — the addon is responsible for substituting a
   *  sane default when omitted. */
  from: z.string().optional(),
  /** Optional `Reply-To` override. */
  replyTo: z.string().optional(),
  subject: z.string(),
  /** Plain-text body. Required even when `html` is present (fallback
   *  for clients that strip HTML — including most spam filters). */
  text: z.string(),
  /** Optional HTML body. Renders alongside `text` as multi-part. */
  html: z.string().optional(),
})

const SendEmailResultSchema = z.object({
  messageId: z.string(),
  accepted: z.array(EmailAddressSchema).default([]),
  rejected: z.array(EmailAddressSchema).default([]),
})

const SmtpStatusSchema = z.object({
  /** True iff the addon has successfully verified the relay. */
  ready: z.boolean(),
  /** Operator-visible host string (no credentials). */
  host: z.string(),
  /** Last error message reported by the relay, when not ready. */
  error: z.string().optional(),
  /** Last successful verify timestamp (unix ms). */
  lastVerifiedAt: z.number().optional(),
})

export const smtpProviderCapability = {
  name: 'smtp-provider',
  scope: 'system',
  mode: 'collection',
  internal: true,
  providerKind: 'email',
  methods: {
    sendEmail: method(SendEmailInputSchema, SendEmailResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      access: 'create',
    }),
    /** Round-trip ping against the SMTP relay (EHLO + AUTH if configured).
     *  Used by the operator's "Test connection" button. */
    verify: method(z.void(), SmtpStatusSchema, { kind: 'mutation', auth: 'admin', access: 'view' }),
    getStatus: method(z.void(), SmtpStatusSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type ISmtpProvider = InferProvider<typeof smtpProviderCapability>
export { SendEmailInputSchema, SendEmailResultSchema, SmtpStatusSchema }
