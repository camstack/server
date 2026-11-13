import { linkFieldDescriptor, userError } from '@camstack/types'
/**
 * Email notifier — delivers through a mail sender the target links to (`sendWith`): an instance
 * that serves `smtp-provider`, an SMTP relay or a Google account (whose kind declares it in
 * `alsoServes`). Not HTTP: the provider calls {@link sendDirect}, which resolves the linked
 * instance to the addon that holds it and sends through that addon's `smtp-provider`.
 */
import type { PreparedNotification, SendResult, TargetKind } from '@camstack/types'
import type { DirectNotifierAdapter, TargetConfig } from './adapter.js'

export const EMAIL_KIND = 'email'

/** The body key of the link to the instance that sends a target's mail. */
export const EMAIL_SENDER_KEY = 'sendWith'

/** The function cap the sender link points at. */
export const EMAIL_SENDER_CAP = 'smtp-provider'

/**
 * The two keys a target written before `sendWith` pinned its sender with: the provider addon and,
 * optionally, one relay of it. Read only for a row the `email-send-with` migration has not moved yet.
 */
export const LEGACY_SMTP_ADDON_KEY = 'smtpAddonId'
export const LEGACY_SMTP_INSTANCE_KEY = 'smtpInstanceId'

export interface EmailSendInput {
  readonly to: string | readonly string[]
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly from?: string
  readonly addonId?: string
  /** The sending instance inside the provider (a relay, a Google account); absent = its default. */
  readonly instanceId?: string
}

/** Where a linked sender lives: the provider addon that holds the instance, and the instance. */
export interface EmailSender {
  readonly addonId: string
  readonly instanceId: string
}

export interface EmailSmtpClient {
  sendEmail(input: EmailSendInput): Promise<{ readonly messageId: string }>
  /**
   * The provider that holds the instance `instanceId` serving `smtp-provider`; null when no holder
   * lists it. Rejects when a holder could not answer, so a failed read never reads as "gone".
   */
  resolveSender?(instanceId: string): Promise<EmailSender | null>
}

const BODY_MAX = 100_000

/** The email kind descriptor: the recipients, the sender link and an optional From. */
export function buildEmailDescriptor(): TargetKind {
  return {
    kind: EMAIL_KIND,
    label: 'Email',
    icon: 'mail',
    addonId: 'notifiers',
    supportsDiscovery: false,
    configSchema: {
      sections: [
        {
          id: 'email',
          title: 'Email',
          titleKey: 'notifiers:emailDescriptor.s_email.title',
          description: 'Sent through a Google account or an SMTP relay.',
          descriptionKey: 'notifiers:emailDescriptor.s_email.description',
          fields: [
            {
              type: 'text',
              key: 'to',
              label: 'To',
              labelKey: 'notifiers:emailDescriptor.s_email.to.label',
              description: 'Recipient address, or comma-separated list.',
              descriptionKey: 'notifiers:emailDescriptor.s_email.to.description',
              required: true,
            },
            {
              ...linkFieldDescriptor(
                EMAIL_SENDER_KEY,
                { cap: EMAIL_SENDER_CAP },
                {
                  label: 'Send with',
                  description: 'The Google account or SMTP relay that sends this email.',
                },
              ),
              labelKey: 'notifiers:emailDescriptor.s_email.sendWith.label',
              descriptionKey: 'notifiers:emailDescriptor.s_email.sendWith.description',
            },
            {
              type: 'text',
              key: 'from',
              label: 'From (optional)',
              labelKey: 'notifiers:emailDescriptor.s_email.from.label',
              description: 'Override From when the sender allows it.',
              descriptionKey: 'notifiers:emailDescriptor.s_email.from.description',
            },
          ],
        },
      ],
    },
    caps: {
      attachments: { mediaTypes: ['image'], mode: 'url', max: 0 },
      actions: 0,
      levels: [
        { id: 'normal', label: 'Normal', ordinal: 3 },
        { id: 'high', label: 'High', ordinal: 4 },
      ],
      format: ['text', 'html', 'markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: BODY_MAX,
    },
  }
}

function requireTo(config: TargetConfig): string[] {
  const raw = config['to']
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw userError('notifiers.email-to-required', undefined, "email: missing required config 'to'")
  }
  const list = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (list.length === 0)
    throw userError('notifiers.email-to-required', undefined, "email: missing required config 'to'")
  return list
}

function renderBodies(prepared: PreparedNotification): {
  text: string
  html?: string
} {
  const body = prepared.bodyParts[0] ?? prepared.body
  const title = prepared.title?.trim() ?? ''
  const click =
    prepared.clickUrl !== null && prepared.clickUrl !== undefined ? `\n\n${prepared.clickUrl}` : ''
  const text = title !== '' ? `${title}\n\n${body}${click}` : `${body}${click}`
  if (prepared.format === 'html') {
    const titleHtml = title !== '' ? `<h2>${escapeHtml(title)}</h2>` : ''
    const clickHtml =
      prepared.clickUrl !== null && prepared.clickUrl !== undefined
        ? `<p><a href="${escapeHtml(prepared.clickUrl)}">${escapeHtml(prepared.clickUrl)}</a></p>`
        : ''
    return {
      text,
      html: `${titleHtml}<div>${body}</div>${clickHtml}`,
    }
  }
  return { text }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function trimmed(config: TargetConfig, key: string): string | undefined {
  const raw = config[key]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/**
 * Where a target's mail goes: the linked sender resolved to its holder, or — for a row the migration
 * has not moved yet — the provider and relay it pinned before. Throws a reason an operator can read.
 */
async function senderOf(smtp: EmailSmtpClient, config: TargetConfig): Promise<EmailSendRoute> {
  const linked = trimmed(config, EMAIL_SENDER_KEY)
  if (linked !== undefined) {
    if (smtp.resolveSender === undefined) {
      throw new Error('email: no mail sender can be resolved on this node')
    }
    const sender = await smtp.resolveSender(linked)
    if (sender === null) {
      throw userError(
        'notifiers.email-sender-gone',
        { id: linked },
        `email: the sender ${linked} no longer exists — pick another under Send with`,
      )
    }
    return { addonId: sender.addonId, instanceId: sender.instanceId }
  }
  const legacyAddon = trimmed(config, LEGACY_SMTP_ADDON_KEY)
  if (legacyAddon !== undefined) {
    const legacyInstance = trimmed(config, LEGACY_SMTP_INSTANCE_KEY)
    return {
      addonId: legacyAddon,
      ...(legacyInstance !== undefined ? { instanceId: legacyInstance } : {}),
    }
  }
  throw userError(
    'notifiers.email-sender-required',
    undefined,
    'email: pick the account or relay under Send with',
  )
}

/** The pin `smtp-provider.sendEmail` is routed by. */
interface EmailSendRoute {
  readonly addonId: string
  readonly instanceId?: string
}

/**
 * The save-time rule: an email target names the sender it sends with. A row the email-send-with
 * migration has not converted yet still names its provider (`smtpAddonId` / `smtpInstanceId`) and
 * sends through it, so a switch or a rename of it is not refused.
 */
export function validateEmailConfig(config: TargetConfig): void {
  const legacy =
    trimmed(config, LEGACY_SMTP_ADDON_KEY) !== undefined ||
    trimmed(config, LEGACY_SMTP_INSTANCE_KEY) !== undefined
  if (!legacy && trimmed(config, EMAIL_SENDER_KEY) === undefined) {
    throw userError(
      'notifiers.email-sender-required',
      undefined,
      'email: pick the account or relay under Send with',
    )
  }
}

/** Build the email adapter bound to a live smtp-provider client. */
export function createEmailAdapter(smtp: EmailSmtpClient): DirectNotifierAdapter {
  return {
    descriptor: buildEmailDescriptor(),
    destinationKeys: ['to', EMAIL_SENDER_KEY],
    validateConfig: validateEmailConfig,
    async sendDirect(config, prepared): Promise<SendResult> {
      try {
        const to = requireTo(config)
        const bodies = renderBodies(prepared)
        const route = await senderOf(smtp, config)
        const subject =
          prepared.title?.trim() && prepared.title.trim().length > 0
            ? prepared.title.trim()
            : 'CamStack notification'
        const from = trimmed(config, 'from')
        await smtp.sendEmail({
          to,
          subject,
          text: bodies.text,
          ...(bodies.html !== undefined ? { html: bodies.html } : {}),
          addonId: route.addonId,
          ...(route.instanceId !== undefined ? { instanceId: route.instanceId } : {}),
          ...(from !== undefined ? { from } : {}),
        })
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}
