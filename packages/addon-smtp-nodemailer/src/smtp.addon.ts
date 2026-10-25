/**
 * SMTP Email addon — wraps `nodemailer` and registers a
 * `smtp-provider` cap collection entry.
 *
 * The provider implements the three cap methods (`sendEmail`,
 * `verify`, `getStatus`) by translating the cap input shape onto
 * nodemailer's `Transporter` API. The transporter is rebuilt lazily
 * whenever the relay config changes; failures are surfaced via the
 * in-memory `lastError` / `lastSentAt` state instead of throwing on
 * boot — operators see the error in the Integrations status badge.
 *
 * Settings are kept minimal on purpose — `host`/`port`/`secure` +
 * optional `username`/`password` cover the 90% case (Postmark,
 * Mailgun, Mailtrap, internal Postfix). Per-message overrides are
 * supported via the cap input (`from`, `replyTo`, `cc`, `bcc`).
 */
import {
  BaseAddon,
  smtpProviderCapability,
  type ProviderRegistration,
  type ISmtpProvider,
} from '@camstack/types'
import { z } from 'zod'
import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'

// ── Settings schema (Zod for symmetry with cap shapes) ──────────────

const SmtpConfigSchema = z.object({
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(587),
  /** Use TLS on connect (port 465 style). When false the transporter
   *  may still STARTTLS — nodemailer auto-detects. */
  secure: z.boolean().default(false),
  username: z.string().default(''),
  password: z.string().default('').meta({ secret: true }),
  /** Default `From` address — used when the caller omits `from`. */
  fromAddress: z.string().default(''),
  /** Optional display name prefixing the `From` address. */
  fromName: z.string().default(''),
})

type SmtpConfig = z.infer<typeof SmtpConfigSchema>

const DEFAULT_CONFIG: SmtpConfig = SmtpConfigSchema.parse({})

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build the RFC 5322 `From` header from config. When `fromName` is
 * set we emit `"Name" <addr>` so most clients render it; otherwise
 * we pass the bare address through (nodemailer accepts both).
 */
function buildFromHeader(cfg: Readonly<SmtpConfig>): string {
  if (!cfg.fromAddress) return ''
  if (cfg.fromName) return `"${cfg.fromName}" <${cfg.fromAddress}>`
  return cfg.fromAddress
}

function buildTransportOptions(cfg: Readonly<SmtpConfig>): SMTPTransport.Options {
  const opts: SMTPTransport.Options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
  }
  if (cfg.username) {
    opts.auth = {
      user: cfg.username,
      pass: cfg.password,
    }
  }
  return opts
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Addon ───────────────────────────────────────────────────────────

export class SmtpNodemailerAddon extends BaseAddon<SmtpConfig> {
  private transporter: Transporter<SMTPTransport.SentMessageInfo> | null = null
  private lastVerifyOk: boolean = false
  private lastError: string | undefined
  private lastVerifiedAt: number | undefined

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.rebuildTransporter()

    this.ctx.addDisposer(async () => {
      this.closeTransporter()
    })

    const provider: ISmtpProvider = {
      sendEmail: async (input) => this.sendEmail(input),
      verify: async () => this.verify(),
      getStatus: async () => this.getStatus(),
    }

    return [{ capability: smtpProviderCapability, provider }]
  }

  protected async onShutdown(): Promise<void> {
    this.closeTransporter()
  }

  protected async onConfigChanged(): Promise<void> {
    this.rebuildTransporter()
    // Reset cached verify state — the new relay needs a fresh probe.
    this.lastVerifyOk = false
    this.lastError = undefined
    this.lastVerifiedAt = undefined
  }

  // ── Cap methods ───────────────────────────────────────────────────

  private async sendEmail(input: {
    to: string | readonly string[]
    cc?: readonly string[]
    bcc?: readonly string[]
    from?: string
    replyTo?: string
    subject: string
    text: string
    html?: string
  }): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    if (!this.transporter) {
      throw new Error('smtp-nodemailer: transporter not configured — set host/port in settings')
    }

    const from = input.from ?? buildFromHeader(this.config)
    if (!from) {
      throw new Error(
        'smtp-nodemailer: no `from` address — set `fromAddress` in settings or pass `from` in the input',
      )
    }

    // nodemailer's `MailOptions` types require mutable arrays — spread
    // produces a fresh mutable copy from the readonly cap input.
    const toField: string | string[] = typeof input.to === 'string' ? input.to : [...input.to]
    const mailOptions: SMTPTransport.MailOptions = {
      from,
      to: toField,
      subject: input.subject,
      text: input.text,
    }
    if (input.cc && input.cc.length > 0) mailOptions.cc = [...input.cc]
    if (input.bcc && input.bcc.length > 0) mailOptions.bcc = [...input.bcc]
    if (input.replyTo) mailOptions.replyTo = input.replyTo
    if (input.html) mailOptions.html = input.html

    try {
      const info = await this.transporter.sendMail(mailOptions)
      this.lastError = undefined
      this.ctx.logger.info('smtp send ok', {
        meta: {
          messageId: info.messageId,
          acceptedCount: info.accepted.length,
          rejectedCount: info.rejected.length,
        },
        tags: { topic: 'smtp', phase: 'sent' },
      })
      return {
        messageId: info.messageId,
        accepted: info.accepted.map(coerceAddress),
        rejected: info.rejected.map(coerceAddress),
      }
    } catch (err) {
      this.lastError = errMsg(err)
      this.ctx.logger.warn('smtp send failed', {
        meta: { error: this.lastError },
        tags: { topic: 'smtp', phase: 'send-failed' },
      })
      throw err
    }
  }

  private async verify(): Promise<{
    ready: boolean
    host: string
    error?: string
    lastVerifiedAt?: number
  }> {
    if (!this.transporter) {
      this.lastVerifyOk = false
      this.lastError = 'transporter not configured'
      return this.getStatus()
    }
    try {
      // nodemailer's `Transporter.verify()` runs an EHLO + AUTH
      // round-trip and resolves `true` on success. Failures throw.
      await this.transporter.verify()
      this.lastVerifyOk = true
      this.lastError = undefined
      this.lastVerifiedAt = Date.now()
      this.ctx.logger.info('smtp verify ok', {
        meta: { host: this.config.host, port: this.config.port },
        tags: { topic: 'smtp', phase: 'verified' },
      })
    } catch (err) {
      this.lastVerifyOk = false
      this.lastError = errMsg(err)
      this.ctx.logger.warn('smtp verify failed', {
        meta: { error: this.lastError },
        tags: { topic: 'smtp', phase: 'verify-failed' },
      })
    }
    return this.getStatus()
  }

  private getStatus(): {
    ready: boolean
    host: string
    error?: string
    lastVerifiedAt?: number
  } {
    const status: {
      ready: boolean
      host: string
      error?: string
      lastVerifiedAt?: number
    } = {
      ready: this.lastVerifyOk,
      host: this.config.host,
    }
    if (this.lastError) status.error = this.lastError
    if (this.lastVerifiedAt !== undefined) status.lastVerifiedAt = this.lastVerifiedAt
    return status
  }

  // ── Transporter lifecycle ─────────────────────────────────────────

  private rebuildTransporter(): void {
    this.closeTransporter()
    if (!this.config.host) {
      // No host configured yet — operator hasn't filled the form.
      // Leave transporter null; status will report `ready: false`.
      return
    }
    try {
      this.transporter = nodemailer.createTransport(buildTransportOptions(this.config))
    } catch (err) {
      this.lastError = errMsg(err)
      this.ctxIfReady?.logger.warn('smtp transporter create failed', {
        meta: { error: this.lastError },
      })
    }
  }

  private closeTransporter(): void {
    if (!this.transporter) return
    try {
      this.transporter.close()
    } catch {
      /* ignore — pool may already be drained */
    }
    this.transporter = null
  }

  // ── Settings UI ───────────────────────────────────────────────────

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'smtp-relay',
          title: 'SMTP Relay',
          description:
            'Outbound SMTP relay used by notifications and alerts. Tested with the per-cap `verify()` button — see the Integrations status badge for the last result.',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Host',
              description: 'SMTP host (e.g. `smtp.postmarkapp.com`).',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              description: 'Common values: 25 (plain), 465 (TLS), 587 (STARTTLS).',
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'secure',
              label: 'Use TLS on connect',
              description: 'Enable for implicit TLS (port 465). Leave off for STARTTLS on 587/25.',
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              description: 'Leave blank for anonymous relays.',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              showToggle: true,
            },
            {
              type: 'text',
              key: 'fromAddress',
              label: 'Default From address',
              description:
                'Used when a `sendEmail` caller omits `from`. Must be authorised by your relay.',
            },
            {
              type: 'text',
              key: 'fromName',
              label: 'Default From display name',
              description: 'Optional. Rendered as `"Name" <addr>` in the From header.',
            },
          ],
        },
      ],
    })
  }
}

/**
 * nodemailer's `accepted` / `rejected` arrays may hold either bare
 * address strings or `{address, name}` objects. The cap return type
 * is `string[]` — coerce so we don't leak the union upstream.
 */
function coerceAddress(entry: string | { address: string }): string {
  if (typeof entry === 'string') return entry
  return entry.address
}

export default SmtpNodemailerAddon
