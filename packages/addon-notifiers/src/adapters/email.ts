import { userError } from '@camstack/types'
/**
 * Email notifier — delivers through a ready `smtp-provider` (Google Gmail API
 * or nodemailer SMTP). Not HTTP: the provider calls {@link sendDirect}.
 */
import type { ConfigOption, PreparedNotification, SendResult, TargetKind } from '@camstack/types'
import type { DirectNotifierAdapter, TargetConfig } from './adapter.js'

export const EMAIL_KIND = 'email'

export interface EmailSendInput {
  readonly to: string | readonly string[]
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly from?: string
  readonly addonId?: string
}

/** One smtp-provider entry the operator can pick as the mail relay. */
export interface SmtpProviderOption {
  readonly value: string
  readonly label: string
  readonly description?: string
  /** False when Connectivity → Email has not verified this entry yet. */
  readonly ready?: boolean
}

export interface EmailSmtpClient {
  sendEmail(input: EmailSendInput): Promise<{ readonly messageId: string }>
  /**
   * Active smtp-provider entries for the target editor select (ready or not —
   * not-ready rows stay selectable so the operator can pick the entry they
   * will Verify). Absent → empty catalog + install/verify prompt.
   */
  listProviders?(): Promise<readonly SmtpProviderOption[]>
  /**
   * When the target omits `smtpAddonId`, pick the first ready provider's
   * addonId (or undefined → collection default routing).
   */
  resolveDefaultAddonId?(): Promise<string | undefined>
}

const BODY_MAX = 100_000

/** Build the email kind descriptor, optionally stamping live provider options. */
export function buildEmailDescriptor(providers: readonly SmtpProviderOption[] = []): TargetKind {
  const options: ConfigOption[] = providers.map((p) => ({
    value: p.value,
    label: p.label,
    ...(p.description !== undefined ? { description: p.description } : {}),
  }))
  const providerDescription =
    options.length === 0
      ? 'No Email provider installed. Open Connectivity → Email, install Google or Email (SMTP), then Verify.'
      : 'Which Connectivity → Email entry delivers this target. Verify it under Connectivity → Email if the label says not verified.'
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
          description:
            'Send via a Connectivity → Email provider (Google or Email (SMTP)). Install and Verify a provider first.',
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
              type: 'select',
              key: 'smtpAddonId',
              label: 'Email provider',
              labelKey: 'notifiers:emailDescriptor.s_email.smtpAddonId.label',
              description: providerDescription,
              required: true,
              options,
            },
            {
              type: 'text',
              key: 'from',
              label: 'From (optional)',
              labelKey: 'notifiers:emailDescriptor.s_email.from.label',
              description: 'Override From when the relay allows it.',
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

function renderBodies(prepared: PreparedNotification): { text: string; html?: string } {
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

/** Build the email adapter bound to a live smtp-provider client. */
export function createEmailAdapter(smtp: EmailSmtpClient): DirectNotifierAdapter {
  return {
    descriptor: buildEmailDescriptor(),
    hydrateDescriptor: async () => {
      const providers = (await smtp.listProviders?.()) ?? []
      return buildEmailDescriptor(providers)
    },
    destinationKeys: ['to', 'smtpAddonId'],
    async sendDirect(config, prepared): Promise<SendResult> {
      try {
        const to = requireTo(config)
        const bodies = renderBodies(prepared)
        const configuredAddon =
          typeof config['smtpAddonId'] === 'string' && config['smtpAddonId'].trim() !== ''
            ? config['smtpAddonId'].trim()
            : undefined
        const addonId = configuredAddon ?? (await smtp.resolveDefaultAddonId?.())
        if (addonId === undefined) {
          throw new Error(
            'email: pick an Email provider (Connectivity → Email) — none ready or none selected',
          )
        }
        const subject =
          prepared.title?.trim() && prepared.title.trim().length > 0
            ? prepared.title.trim()
            : 'CamStack notification'
        const from =
          typeof config['from'] === 'string' && config['from'].trim() !== ''
            ? config['from'].trim()
            : undefined
        await smtp.sendEmail({
          to,
          subject,
          text: bodies.text,
          ...(bodies.html !== undefined ? { html: bodies.html } : {}),
          addonId,
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
