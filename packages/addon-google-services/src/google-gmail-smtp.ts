import { userError } from '@camstack/types'
/**
 * Gmail API implementation of `smtp-provider` — send via users.messages.send
 * with a raw RFC 2822 MIME message (base64url). Aggregates N Google brokers.
 */
import type { ISmtpProvider } from '@camstack/types'
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
}

function encodeBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function formatAddressList(addrs: string | readonly string[]): string {
  return (Array.isArray(addrs) ? addrs : [addrs]).join(', ')
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

/** Build a minimal multipart/alternative-capable plain (and optional HTML) message. */
export function buildRawMime(input: {
  readonly from: string
  readonly to: string | readonly string[]
  readonly cc?: readonly string[]
  readonly bcc?: readonly string[]
  readonly replyTo?: string
  readonly subject: string
  readonly text: string
  readonly html?: string
}): string {
  const lines: string[] = [`From: ${input.from}`, `To: ${formatAddressList(input.to)}`]
  if (input.cc !== undefined && input.cc.length > 0) {
    lines.push(`Cc: ${formatAddressList(input.cc)}`)
  }
  if (input.bcc !== undefined && input.bcc.length > 0) {
    lines.push(`Bcc: ${formatAddressList(input.bcc)}`)
  }
  if (input.replyTo !== undefined && input.replyTo.length > 0) {
    lines.push(`Reply-To: ${input.replyTo}`)
  }
  lines.push(`Subject: ${encodeHeaderWord(input.subject)}`)
  lines.push('MIME-Version: 1.0')

  if (input.html !== undefined && input.html.length > 0) {
    const boundary = `camstack_${Date.now().toString(36)}`
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: 8bit')
    lines.push('')
    lines.push(input.text)
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/html; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: 8bit')
    lines.push('')
    lines.push(input.html)
    lines.push(`--${boundary}--`)
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: 8bit')
    lines.push('')
    lines.push(input.text)
  }
  return lines.join('\r\n')
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
    verify: async () => {
      const account = selectGmailAccount(deps.accounts(), undefined)
      if (account === null) {
        lastError = 'No Google broker connected.'
        return status()
      }
      try {
        const token = await account.getAccessToken()
        const res = await http(`${GOOGLE_GMAIL_API}/users/me/profile`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const text = await res.text()
          lastError = `Gmail profile failed (${res.status}): ${text.slice(0, 200)}`
          return status()
        }
        lastError = undefined
        lastVerifiedAt = Date.now()
        return status()
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        return status()
      }
    },
    sendEmail: async (input) => {
      const account = selectGmailAccount(deps.accounts(), input.from)
      if (account === null) {
        throw new Error(
          'No Google broker connected — add one under Connectivity → Brokers and Connect.',
        )
      }
      const from = input.from?.trim() || buildFromHeader(account)
      if (!from) {
        throw userError(
          'google.from-address-required',
          undefined,
          'Set From address on the Google broker (or Connect an account).',
        )
      }
      const raw = buildRawMime({
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.text,
        html: input.html,
      })
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
