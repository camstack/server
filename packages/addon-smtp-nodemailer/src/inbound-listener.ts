/**
 * One smtp-server for one mailbox. It knows nothing about records or subscriptions: the broker
 * tells it which recipients are allowed and what to do with a parsed message.
 */
import { type ParsedMail, simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import type { DraftMessage } from './inbound-ring.js'

export interface ListenerSpec {
  readonly port: number
  readonly bindHost: string
  readonly domain: string
  readonly requireAuth: boolean
  readonly username: string
  readonly password: string
  readonly starttls: boolean
  readonly maxMessageBytes: number
}

/** The listener's view of the world: who may receive, where a message goes, what to say. */
export interface ListenerDeps {
  /** True when the local-part is subscribed. */
  readonly isAllowed: (localPart: string) => boolean
  /** One call per allowed recipient of one accepted message. */
  readonly onMail: (localPart: string, draft: DraftMessage) => void
  readonly log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
}

export interface MailListener {
  start(): Promise<void>
  stop(): Promise<void>
}

export type ListenerFactory = (spec: ListenerSpec, deps: ListenerDeps) => MailListener

const SOCKET_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 30_000
const MAX_CLIENTS = 50
const RELISTEN_DELAY_MS = 5_000

/** `user@domain` and `user` name the same account when the domain is this mailbox's. */
function stripDomain(user: string, domain: string): string {
  const at = user.lastIndexOf('@')
  if (at < 0) return user
  return user.slice(at + 1).toLowerCase() === domain.toLowerCase() ? user.slice(0, at) : user
}

/** Split `local@domain`. The local-part keeps its case (Reolink UIDs are mixed-case). */
export function splitRecipient(rcpt: string): { local: string; domain: string } | null {
  const at = rcpt.lastIndexOf('@')
  if (at <= 0 || at === rcpt.length - 1) return null
  return { local: rcpt.slice(0, at), domain: rcpt.slice(at + 1).toLowerCase() }
}

function fromText(parsed: ParsedMail): string {
  return parsed.from === undefined ? '' : parsed.from.text
}

function draftFrom(parsed: ParsedMail, to: string, receivedAt: number): DraftMessage {
  return {
    messageId: parsed.messageId ?? '',
    receivedAt,
    from: fromText(parsed),
    to,
    subject: parsed.subject ?? '',
    text: (parsed.text ?? '').slice(0, 4096),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? '',
      contentType: a.contentType,
      bytes: a.size,
    })),
  }
}

export const smtpServerFactory: ListenerFactory = (spec, deps) => new SmtpServerListener(spec, deps)

class SmtpServerListener implements MailListener {
  private server: SMTPServer | null = null

  constructor(
    private readonly spec: ListenerSpec,
    private readonly deps: ListenerDeps,
  ) {}

  private allowedLocal(rcpt: string): string | null {
    const parts = splitRecipient(rcpt)
    if (parts === null || parts.domain !== this.spec.domain.toLowerCase()) return null
    return this.deps.isAllowed(parts.local) ? parts.local : null
  }

  start(): Promise<void> {
    const { spec, deps } = this
    const server = new SMTPServer({
      authOptional: !spec.requireAuth,
      disabledCommands: [
        ...(spec.requireAuth ? [] : ['AUTH']),
        ...(spec.starttls ? [] : ['STARTTLS']),
      ],
      allowInsecureAuth: !spec.starttls,
      size: spec.maxMessageBytes,
      maxClients: MAX_CLIENTS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      closeTimeout: CLOSE_TIMEOUT_MS,
      logger: false,
      onAuth: (auth, session, callback) => {
        const wanted = stripDomain(spec.username, spec.domain)
        const tried = stripDomain(auth.username ?? '', spec.domain)
        if (
          spec.username.length > 0 &&
          spec.password.length > 0 &&
          tried === wanted &&
          auth.password === spec.password
        ) {
          callback(null, { user: auth.username })
          return
        }
        deps.log('warn', `AUTH failed from ${session.remoteAddress}`)
        callback(new Error('Invalid username or password'))
      },
      onRcptTo: (address, session, callback) => {
        if (this.allowedLocal(address.address) === null) {
          deps.log('warn', `RCPT ${address.address} refused (550) from ${session.remoteAddress}`)
          const refusal = new Error(`Unknown recipient ${address.address}`)
          callback(Object.assign(refusal, { responseCode: 550 }))
          return
        }
        callback()
      },
      onData: (stream, session, callback) => {
        const chunks: Buffer[] = []
        let received = 0
        stream.on('data', (chunk: Buffer) => {
          // Past the limit nothing more is kept: the peer is answered 552 at the end.
          received += chunk.length
          if (received <= spec.maxMessageBytes) chunks.push(chunk)
        })
        stream.on('error', (err: Error) => callback(err))
        stream.on('end', () => {
          if (stream.sizeExceeded || received > spec.maxMessageBytes) {
            deps.log(
              'warn',
              `message from ${session.remoteAddress} exceeds ${spec.maxMessageBytes} bytes (552)`,
            )
            callback(
              Object.assign(new Error('Message size exceeds the limit'), {
                responseCode: 552,
              }),
            )
            return
          }
          const rcpts = (session.envelope.rcptTo ?? []).map((r) => r.address)
          const local = rcpts.flatMap((r) => {
            const l = this.allowedLocal(r)
            return l === null ? [] : [{ rcpt: r, local: l }]
          })
          if (local.length === 0) {
            callback(new Error('No recognised recipients'))
            return
          }
          simpleParser(Buffer.concat(chunks)).then(
            (parsed) => {
              const receivedAt = Date.now()
              for (const r of local) deps.onMail(r.local, draftFrom(parsed, r.rcpt, receivedAt))
              callback()
            },
            (err: unknown) => {
              deps.log(
                'warn',
                `unparseable mail: ${err instanceof Error ? err.message : String(err)}`,
              )
              callback(new Error('Message could not be parsed'))
            },
          )
        })
      },
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      deps.log('error', `SMTP server error: ${err.code ?? ''} ${err.message}`)
      // A listener lost to a transient accept error (EMFILE) re-arms; per-connection errors keep
      // the socket listening and do nothing here.
      if (this.server === server && !server.server.listening) {
        setTimeout(() => {
          if (this.server !== server) return
          server.listen(spec.port, spec.bindHost, () => deps.log('warn', 'SMTP listener re-bound'))
        }, RELISTEN_DELAY_MS).unref()
      }
    })
    return new Promise<void>((resolve, reject) => {
      const onStartError = (err: Error): void => reject(err)
      server.once('error', onStartError)
      server.listen(spec.port, spec.bindHost, () => {
        server.off('error', onStartError)
        this.server = server
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return Promise.resolve()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
