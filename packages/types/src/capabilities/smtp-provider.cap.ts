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

/**
 * Which relay of a multi-relay provider answers (D996). Absent = the provider's first / default
 * relay, so a caller written before relays existed keeps working unchanged. A provider with one
 * fixed relay ignores it. This is the integration instance id (`int_NNNN`), NOT the addon id: the
 * collection pin `addonId` still picks the provider, `instanceId` picks the relay inside it.
 */
const InstanceIdSchema = z.string().min(1).optional()

const RelayPinSchema = z.object({ instanceId: InstanceIdSchema })

const SendEmailInputSchema = z.object({
  instanceId: InstanceIdSchema,
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
  /**
   * The tri-state behind `ready` (D315): true when the last send worked, false when it failed,
   * ABSENT when the relay has not sent yet (unknown, never "not verified").
   */
  verified: z.boolean().optional(),
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
    getStatus: method(RelayPinSchema, SmtpStatusSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type ISmtpProvider = InferProvider<typeof smtpProviderCapability>
export { SendEmailInputSchema, SendEmailResultSchema, SmtpStatusSchema }
