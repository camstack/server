/**
 * The live relays of the SMTP addon: one transporter per `relays` record, kept by registry id.
 *
 * A change to one relay rebuilds only that relay (and resets only its send state). A caller
 * that names no relay gets the first configured one, so everything written before relays
 * existed keeps working. Failures surface through each relay's own `lastError`, never as a
 * throw on boot.
 */
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import { userError, isInstanceEnabled } from '@camstack/types'
import type { SmtpRelayBody } from './relay-record-kinds.js'

/** The part of a nodemailer transporter the pool uses; tests supply a fake of exactly this. */
export interface RelayTransport {
  sendMail(mail: SMTPTransport.MailOptions): Promise<{
    readonly messageId: string
    readonly accepted: ReadonlyArray<string | { readonly address: string }>
    readonly rejected: ReadonlyArray<string | { readonly address: string }>
  }>
  verify(): Promise<unknown>
  close(): void
}

export type TransportFactory = (options: SMTPTransport.Options) => RelayTransport

export const nodemailerFactory: TransportFactory = (options) => nodemailer.createTransport(options)

export interface SendEmailRequest {
  readonly to: string | readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly bcc?: readonly string[] | undefined
  readonly from?: string | undefined
  readonly replyTo?: string | undefined
  readonly subject: string
  readonly text: string
  readonly html?: string | undefined
}

/**
 * `ready` is "the last send worked". A relay that never sent anything is NOT known to be broken:
 * it reads `ready: false` with no `verified` (unknown), where a failed send reads `verified: false`
 * (the connection check is `testInstance`, not this).
 */
export interface RelayStatus {
  ready: boolean
  /** The last send's outcome; absent until the first send (unknown, not failed). */
  verified?: boolean
  host: string
  error?: string
  lastVerifiedAt?: number
}

export interface RelayLog {
  info(message: string, context: Record<string, unknown>): void
  warn(message: string, context: Record<string, unknown>): void
}

interface RelayState {
  readonly id: string
  readonly body: SmtpRelayBody
  readonly transporter: RelayTransport | null
  /** The outcome of the last send; `undefined` until the first one (unknown, not failed). */
  lastSendOk: boolean | undefined
  lastError: string | undefined
  lastVerifiedAt: number | undefined
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `"Name" <addr>` when a display name is set, the bare address otherwise, '' without one. */
export function buildFromHeader(body: Readonly<SmtpRelayBody>): string {
  if (!body.fromAddress) return ''
  if (body.fromName) return `"${body.fromName}" <${body.fromAddress}>`
  return body.fromAddress
}

export function buildTransportOptions(body: Readonly<SmtpRelayBody>): SMTPTransport.Options {
  const options: SMTPTransport.Options = { host: body.host, port: body.port, secure: body.secure }
  if (body.username) options.auth = { user: body.username, pass: body.password ?? '' }
  return options
}

/** An absent `enabled` means on (D996). */
function isOn(body: Readonly<SmtpRelayBody>): boolean {
  return isInstanceEnabled(body)
}

function coerceAddress(entry: string | { readonly address: string }): string {
  return typeof entry === 'string' ? entry : entry.address
}

function sameBody(a: SmtpRelayBody, b: SmtpRelayBody): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.secure === b.secure &&
    a.username === b.username &&
    (a.password ?? '') === (b.password ?? '') &&
    a.fromAddress === b.fromAddress &&
    a.fromName === b.fromName &&
    isOn(a) === isOn(b)
  )
}

export class RelayPool {
  private readonly relays = new Map<string, RelayState>()

  constructor(
    private readonly factory: TransportFactory,
    private readonly log: RelayLog,
  ) {}

  /** Make `id` serve `body`. An unchanged body keeps its transporter and send state. */
  apply(id: string, body: SmtpRelayBody): void {
    const current = this.relays.get(id)
    if (current !== undefined && sameBody(current.body, body)) return
    current?.transporter?.close()
    this.relays.set(id, {
      id,
      body,
      transporter: this.build(id, body),
      lastSendOk: undefined,
      lastError: undefined,
      lastVerifiedAt: undefined,
    })
  }

  remove(id: string): void {
    this.relays.get(id)?.transporter?.close()
    this.relays.delete(id)
  }

  /** Keep exactly the relays in `ids`: drop every other one. */
  retainOnly(ids: ReadonlySet<string>): void {
    for (const id of [...this.relays.keys()]) if (!ids.has(id)) this.remove(id)
  }

  closeAll(): void {
    for (const id of [...this.relays.keys()]) this.remove(id)
  }

  has(id: string): boolean {
    return this.relays.has(id)
  }

  private build(id: string, body: SmtpRelayBody): RelayTransport | null {
    // No host yet: the operator has not filled the form. Status reports `ready: false`.
    if (!body.host) return null
    try {
      return this.factory(buildTransportOptions(body))
    } catch (err: unknown) {
      this.log.warn('smtp transporter create failed', {
        meta: { error: errMsg(err), integrationId: id },
        tags: { topic: 'smtp', phase: 'transport-failed' },
      })
      return null
    }
  }

  /**
   * The named relay (on or off: a pinned caller is answered by that relay or refused, never by
   * another); with no name, the first configured relay that is on (else the first that is on).
   */
  private pick(instanceId: string | undefined): RelayState | undefined {
    if (instanceId !== undefined) return this.relays.get(instanceId)
    const on = [...this.relays.values()].filter((r) => isOn(r.body))
    return on.find((r) => r.body.host !== '') ?? on[0]
  }

  private unknown(instanceId: string | undefined): string {
    if (instanceId === undefined && this.relays.size > 0) {
      return 'smtp-nodemailer: every relay is switched off — switch one on under Integrations'
    }
    return instanceId === undefined
      ? 'smtp-nodemailer: no relay configured — add one under Integrations'
      : `smtp-nodemailer: unknown relay "${instanceId}"`
  }

  async sendEmail(
    instanceId: string | undefined,
    input: SendEmailRequest,
  ): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    const relay = this.pick(instanceId)
    if (relay === undefined) throw new Error(this.unknown(instanceId))
    if (!isOn(relay.body)) {
      this.log.warn('smtp send refused: the relay is switched off', {
        meta: { integrationId: relay.id, relay: relay.body.name },
        tags: { topic: 'smtp', phase: 'relay-disabled' },
      })
      throw userError(
        'smtp.relay-disabled',
        { id: relay.id, name: relay.body.name },
        `smtp-nodemailer: relay "${relay.body.name}" is switched off`,
      )
    }
    if (relay.transporter === null) {
      throw new Error('smtp-nodemailer: transporter not configured — set host/port on the relay')
    }
    const from = input.from ?? buildFromHeader(relay.body)
    if (!from) {
      throw new Error(
        'smtp-nodemailer: no `from` address — set `fromAddress` on the relay or pass `from` in the input',
      )
    }
    // nodemailer's `MailOptions` types require mutable arrays — spread produces a fresh copy.
    const mail: SMTPTransport.MailOptions = {
      from,
      to: typeof input.to === 'string' ? input.to : [...input.to],
      subject: input.subject,
      text: input.text,
    }
    if (input.cc && input.cc.length > 0) mail.cc = [...input.cc]
    if (input.bcc && input.bcc.length > 0) mail.bcc = [...input.bcc]
    if (input.replyTo) mail.replyTo = input.replyTo
    if (input.html) mail.html = input.html
    try {
      const info = await relay.transporter.sendMail(mail)
      relay.lastError = undefined
      // A delivered message is the proof the relay works: the status reads it (the notifier picker's "verified").
      relay.lastSendOk = true
      relay.lastVerifiedAt = Date.now()
      this.log.info('smtp send ok', {
        meta: {
          messageId: info.messageId,
          acceptedCount: info.accepted.length,
          rejectedCount: info.rejected.length,
          integrationId: relay.id,
        },
        tags: { topic: 'smtp', phase: 'sent' },
      })
      return {
        messageId: info.messageId,
        accepted: info.accepted.map(coerceAddress),
        rejected: info.rejected.map(coerceAddress),
      }
    } catch (err: unknown) {
      relay.lastSendOk = false
      relay.lastError = errMsg(err)
      this.log.warn('smtp send failed', {
        meta: { error: relay.lastError, integrationId: relay.id },
        tags: { topic: 'smtp', phase: 'send-failed' },
      })
      throw err
    }
  }

  status(instanceId: string | undefined): RelayStatus {
    const relay = this.pick(instanceId)
    if (relay === undefined) return { ready: false, host: '', error: this.unknown(instanceId) }
    return this.statusOf(relay)
  }

  private statusOf(relay: RelayState): RelayStatus {
    // A relay that is off is not ready, and that is not an error (D62: off must not look broken).
    const status: RelayStatus = {
      ready: isOn(relay.body) && relay.lastSendOk === true,
      host: relay.body.host,
    }
    if (isOn(relay.body) && relay.lastSendOk !== undefined) status.verified = relay.lastSendOk
    if (relay.lastError) status.error = relay.lastError
    if (relay.lastVerifiedAt !== undefined) status.lastVerifiedAt = relay.lastVerifiedAt
    return status
  }
}
