/**
 * Gmail API implementation of `smtp-provider` — send via users.messages.send
 * with a raw RFC 2822 MIME message (base64url). Aggregates N Google brokers.
 *
 * The MIME body is {@link assembleEmailMime}, the same function the SMTP relay
 * uses. Image bytes arrive as `peerBytes` tickets (D613).
 */
import {
  assembleEmailMime,
  buildRawMime,
  userError,
  type AddonPeerBytes,
  type IScopedLogger,
  type ISmtpProvider,
  type PeerBytesOpenResult,
  type PeerBytesTicket,
} from '@camstack/types'
import { GOOGLE_GMAIL_API } from './google-types.js'

export interface GmailAccountView {
  readonly brokerId: string
  readonly accountEmail: string
  readonly fromAddress: string
  readonly fromName: string
  readonly connected: boolean
  readonly getAccessToken: () => Promise<string>
}

export interface GmailSmtpDeps {
  readonly accounts: () => readonly GmailAccountView[]
  readonly fetch?: typeof fetch
  /** Opens image tickets. Absent: a mail that names an image is sent without it. */
  readonly peerBytes?: Pick<AddonPeerBytes, 'open'>
  readonly logger?: Pick<IScopedLogger, 'warn'>
}

export { buildRawMime }

function encodeBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function buildFromHeader(account: GmailAccountView): string {
  const addr = account.fromAddress.trim() || account.accountEmail
  if (!addr) return ''
  if (account.fromName.trim()) return `${encodeHeaderWord(account.fromName.trim())} <${addr}>`
  return addr
}

function extractEmail(fromHeader: string): string {
  const angled = /<([^>]+)>/.exec(fromHeader)
  if (angled?.[1] !== undefined) return angled[1].trim().toLowerCase()
  return fromHeader.trim().toLowerCase()
}

/** Pick account: match From to accountEmail/fromAddress; else first connected. */
export function selectGmailAccount(
  accounts: readonly GmailAccountView[],
  fromHeader: string | undefined,
): GmailAccountView | null {
  const connected = accounts.filter((a) => a.connected)
  if (connected.length === 0) return null
  if (fromHeader === undefined || fromHeader.trim().length === 0) {
    return connected[0] ?? null
  }
  const want = extractEmail(fromHeader)
  for (const a of connected) {
    const candidates = [a.accountEmail, a.fromAddress]
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
    if (candidates.includes(want)) return a
  }
  return connected[0] ?? null
}

/** What a send names its account by: the linked instance (a broker id), else the From header. */
export interface GmailSenderPick {
  readonly instanceId?: string
  readonly from?: string
}

/**
 * The account a send goes out from. A send that names an instance (an email target's `sendWith`
 * link) uses exactly that account and is refused when it is not connected — mail never leaves from
 * another account. A send without one keeps choosing by From, else the first connected account.
 */
export function selectGmailSender(
  accounts: readonly GmailAccountView[],
  pick: GmailSenderPick,
): GmailAccountView {
  if (pick.instanceId !== undefined) {
    const named = accounts.find((account) => account.brokerId === pick.instanceId)
    if (named === undefined || !named.connected) {
      throw new Error(
        `The Google account ${pick.instanceId} is not connected — sign it in again under Integrations.`,
      )
    }
    return named
  }
  const account = selectGmailAccount(accounts, pick.from)
  if (account === null) {
    throw new Error(
      'No Google broker connected — add one under Connectivity → Brokers and Connect.',
    )
  }
  return account
}

function openTicket(deps: GmailSmtpDeps, ticket: PeerBytesTicket): Promise<PeerBytesOpenResult> {
  const peer = deps.peerBytes
  if (peer === undefined) {
    return Promise.resolve({ kind: 'refused', code: 'unreachable', detail: 'no peerBytes' })
  }
  return peer.open(ticket)
}

function dropImage(deps: GmailSmtpDeps, reason: string, deviceId: number | undefined): void {
  deps.logger?.warn(`email image omitted: ${reason}`, {
    meta: { reason },
    ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
  })
}

export function createGmailSmtpProvider(deps: GmailSmtpDeps): ISmtpProvider {
  const http = deps.fetch ?? fetch
  let lastVerifiedAt: number | undefined
  let lastError: string | undefined

  const status = () => {
    const connected = deps.accounts().filter((a) => a.connected)
    const host =
      connected[0]?.accountEmail ||
      connected[0]?.fromAddress.trim() ||
      (connected.length > 0 ? 'gmail' : 'gmail')
    if (connected.length === 0) {
      return {
        ready: false,
        host,
        error: 'No Google broker connected — add one under Connectivity → Brokers and Connect.',
        lastVerifiedAt,
      }
    }
    return {
      ready: lastError === undefined && lastVerifiedAt !== undefined,
      host: connected.length === 1 ? host : `${host} (+${connected.length - 1})`,
      error: lastError,
      lastVerifiedAt,
    }
  }

  return {
    getStatus: async () => status(),
    sendEmail: async (input) => {
      const account = selectGmailSender(deps.accounts(), {
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
      })
      const from = input.from?.trim() || buildFromHeader(account)
      if (!from) {
        throw userError(
          'google.from-address-required',
          undefined,
          'Set From address on the Google broker (or Connect an account).',
        )
      }
      const raw = await assembleEmailMime(
        {
          from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          ...(input.cc !== undefined ? { cc: input.cc } : {}),
          ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.images !== undefined ? { images: input.images } : {}),
        },
        (ticket) => openTicket(deps, ticket),
        (reason, deviceId) => dropImage(deps, reason, deviceId),
      )
      const token = await account.getAccessToken()
      const res = await http(`${GOOGLE_GMAIL_API}/users/me/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encodeBase64Url(Buffer.from(raw, 'utf8')) }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Gmail send failed (${res.status}): ${text.slice(0, 400)}`)
      }
      const body = (await res.json()) as { id?: string }
      const messageId = body.id ?? `gmail-${Date.now()}`
      lastError = undefined
      lastVerifiedAt = Date.now()
      const toList = Array.isArray(input.to) ? input.to : [input.to]
      return { messageId, accepted: [...toList], rejected: [] }
    },
  }
}
