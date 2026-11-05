/**
 * The `smtp-inbound` broker kind (D999): a mailbox a device can send alarm mail to.
 *
 * One `mailboxes` record = one broker = one smtp-server, bound only while the record exists.
 * A consumer subscribes with the recipient local-parts it owns; the union of the subscriptions is
 * the RCPT allowlist. Messages are published as `broker.message` events and kept in a bounded ring
 * so a consumer that lost an event replays the gap by RPC (events are telemetry, D8).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import {
  type BrokerInfo,
  type ConfigUISchema,
  type IBrokerProvider,
  type RecordKindHandle,
  RecordSecretUnavailableError,
  SMTP_INBOUND_KIND,
  SMTP_RECIPIENT_CLAIMED,
  SmtpInboundFilterSchema,
  type SmtpInboundMessage,
  SmtpInboundSettingsSchema,
  parseSmtpSinceKey,
  assertBrokerUnused,
  type BrokerUserFinder,
} from '@camstack/types'
import type { ListenerFactory, ListenerSpec } from './inbound-listener.js'
import { type DraftMessage, MessageRing } from './inbound-ring.js'
import { type MailboxBody, MailboxBodySchema } from './mailbox-record-kinds.js'

/** The cap's broker status (the bare `BrokerState` name is another type in `@camstack/types`). */
type BrokerState = BrokerInfo['status']

export interface MessageEmission {
  readonly brokerId: string
  readonly subscriptionId: string
  readonly key: string
  readonly payload: SmtpInboundMessage
}

export interface StatusEmission {
  readonly brokerId: string
  readonly status: BrokerState
  readonly error?: string
}

export interface InboundBrokerDeps {
  readonly addonId: string
  readonly handle: Pick<
    RecordKindHandle<MailboxBody>,
    'get' | 'getResolved' | 'put' | 'delete' | 'query'
  >
  readonly factory: ListenerFactory
  /** The hostname of the `internal` role of the network palette, or null when it is not set. */
  readonly readInternalHost: () => Promise<string | null>
  readonly emitMessage: (emission: MessageEmission) => void
  readonly emitStatus: (emission: StatusEmission) => void
  readonly log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
  /** Pause before a failed bind is tried again; a spec shortens it. */
  readonly rebindDelayMs?: number
}

/** A listener that could not bind (a port still held by the previous owner) is retried this often. */
const REBIND_DELAY_MS = 5_000
const MAX_REBIND_ATTEMPTS = 6

export const NO_INTERNAL_HOST_REASON =
  'The hub has no internal address. Flag one as "Internal" under System → Network; cameras need it to reach this mailbox.'

const KIND_LABEL = 'Inbound mailbox (SMTP)'
const PAGE = 500

/** The hostname of a role's resolved base URL (`http://192.0.2.10:4480` → `192.0.2.10`). */
export function hostFromRole(resolved: string | null): string | null {
  if (resolved === null || resolved.trim().length === 0) return null
  try {
    const host = new URL(resolved).hostname
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

interface Subscription {
  readonly id: string
  readonly subscriberId: string
  readonly recipients: ReadonlySet<string>
}

interface Runtime {
  readonly spec: ListenerSpec
  readonly stop: () => Promise<void>
  readonly ring: MessageRing
  subscriptions: Map<string, Subscription>
  status: BrokerState
  error: string | null
  checkedAt: number
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function specOf(body: MailboxBody, password: string): ListenerSpec {
  return {
    port: body.port,
    bindHost: body.bindHost,
    domain: body.domain,
    requireAuth: body.requireAuth,
    username: body.username,
    password,
    starttls: body.starttls,
    maxMessageBytes: body.maxMessageBytes,
  }
}

function sameSpec(a: ListenerSpec, b: ListenerSpec): boolean {
  return (
    a.port === b.port &&
    a.bindHost === b.bindHost &&
    a.domain === b.domain &&
    a.requireAuth === b.requireAuth &&
    a.username === b.username &&
    a.password === b.password &&
    a.starttls === b.starttls &&
    a.maxMessageBytes === b.maxMessageBytes
  )
}

export class SmtpInboundBroker {
  private readonly runtimes = new Map<string, Runtime>()
  /** Serialises record -> listener reconciliation per mailbox. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Nothing is emitted before the addon is reachable: a consumer's first call would fail. */
  private announced = false
  private readonly lastStatus = new Map<string, StatusEmission>()
  private readonly rebindTimers = new Map<string, NodeJS.Timeout>()
  private readonly rebindAttempts = new Map<string, number>()

  constructor(private readonly deps: InboundBrokerDeps) {}

  /** Bind a listener for every mailbox record. With none, nothing is bound. */
  async start(): Promise<void> {
    const page = await this.deps.handle.query({ limit: PAGE })
    for (const row of page.records) await this.reconcile(row.id)
  }

  /**
   * The addon is registered and reachable: tell every consumer the state of every mailbox.
   * Until now the statuses were only recorded (`start()` runs inside `onInitialize`, before the
   * capability exists, so an event emitted then would be answered by a failing subscribe).
   */
  announce(): void {
    this.announced = true
    for (const status of this.lastStatus.values()) this.deps.emitStatus(status)
  }

  /**
   * Re-apply every mailbox that is not serving (a keychain that unlocked since): a locked read
   * leaves the record unbound and nothing else would look at it again.
   */
  async retryUnavailable(): Promise<void> {
    const page = await this.deps.handle.query({ limit: PAGE })
    for (const row of page.records) {
      const runtime = this.runtimes.get(row.id)
      if (runtime === undefined || runtime.status !== 'connected') await this.reconcile(row.id)
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.rebindTimers.values()) clearTimeout(timer)
    this.rebindTimers.clear()
    await Promise.all([...this.runtimes.keys()].map((id) => this.unbind(id)))
  }

  // ── record -> listener ────────────────────────────────────────────────────

  private reconcile(id: string): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(() => this.applyRecord(id))
    this.chains.set(
      id,
      next.catch(() => undefined),
    )
    return next
  }

  private async applyRecord(id: string): Promise<void> {
    let row: Awaited<ReturnType<InboundBrokerDeps['handle']['getResolved']>>
    try {
      row = await this.deps.handle.getResolved(id)
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
      // A locked keychain is a failed read of the password, never an empty one (D49): the
      // running listener keeps its configuration, and one that is not running stays unbound.
      this.deps.log(
        'warn',
        `smtp-inbound ${id}: the keychain is locked; the mailbox keeps its previous configuration`,
      )
      const kept = this.runtimes.get(id)
      if (kept === undefined)
        this.setStatus(
          id,
          null,
          'error',
          'The keychain is locked; the mailbox password cannot be read',
        )
      return
    }
    if (row === null) {
      await this.unbind(id)
      return
    }
    const spec = specOf(row.data, row.data.password ?? '')
    const current = this.runtimes.get(id)
    if (current !== undefined && sameSpec(current.spec, spec) && current.status === 'connected')
      return
    await this.bind(id, spec, current)
  }

  private async bind(id: string, spec: ListenerSpec, current: Runtime | undefined): Promise<void> {
    if (current !== undefined) await current.stop()
    const ring = current?.ring ?? new MessageRing()
    const subscriptions = current?.subscriptions ?? new Map<string, Subscription>()
    const listener = this.deps.factory(spec, {
      isAllowed: (local) => this.isAllowed(id, local),
      onMail: (local, draft) => this.onMail(id, local, draft),
      log: (level, message) => this.deps.log(level, `smtp-inbound ${id}: ${message}`),
    })
    const runtime: Runtime = {
      spec,
      stop: () => listener.stop(),
      ring,
      subscriptions,
      status: 'connecting',
      error: null,
      checkedAt: Date.now(),
    }
    this.runtimes.set(id, runtime)
    try {
      await listener.start()
      this.rebindAttempts.delete(id)
      this.setStatus(id, runtime, 'connected', null)
      this.deps.log('info', `smtp-inbound ${id}: listening on ${spec.bindHost}:${spec.port}`)
    } catch (err: unknown) {
      this.setStatus(id, runtime, 'error', errMsg(err))
      this.deps.log(
        'error',
        `smtp-inbound ${id}: could not listen on ${spec.bindHost}:${spec.port}: ${errMsg(err)}`,
      )
      this.scheduleRebind(id)
    }
  }

  /** A bounded retry of a failed bind; each attempt is logged, the last one says it is the last. */
  private scheduleRebind(id: string): void {
    const attempt = (this.rebindAttempts.get(id) ?? 0) + 1
    if (attempt > MAX_REBIND_ATTEMPTS) {
      this.deps.log(
        'error',
        `smtp-inbound ${id}: giving up binding after ${MAX_REBIND_ATTEMPTS} attempts; save the mailbox again to retry`,
      )
      this.rebindAttempts.delete(id)
      return
    }
    this.rebindAttempts.set(id, attempt)
    if (this.rebindTimers.has(id)) return
    const timer = setTimeout(() => {
      this.rebindTimers.delete(id)
      this.deps.log(
        'info',
        `smtp-inbound ${id}: binding again (attempt ${attempt}/${MAX_REBIND_ATTEMPTS})`,
      )
      void this.reconcile(id).catch((err: unknown) => {
        this.deps.log('warn', `smtp-inbound ${id}: rebind failed: ${errMsg(err)}`)
      })
    }, this.deps.rebindDelayMs ?? REBIND_DELAY_MS)
    timer.unref()
    this.rebindTimers.set(id, timer)
  }

  private async unbind(id: string): Promise<void> {
    const timer = this.rebindTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.rebindTimers.delete(id)
    this.rebindAttempts.delete(id)
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    if (runtime !== undefined) await runtime.stop()
  }

  private setStatus(
    id: string,
    runtime: Runtime | null,
    status: BrokerState,
    error: string | null,
  ): void {
    if (runtime !== null) {
      runtime.status = status
      runtime.error = error
      runtime.checkedAt = Date.now()
    }
    const emission: StatusEmission = {
      brokerId: id,
      status,
      ...(error === null ? {} : { error }),
    }
    this.lastStatus.set(id, emission)
    if (this.announced) this.deps.emitStatus(emission)
  }

  // ── mail ──────────────────────────────────────────────────────────────────

  private claimant(runtime: Runtime, local: string): Subscription | undefined {
    for (const sub of runtime.subscriptions.values()) if (sub.recipients.has(local)) return sub
    return undefined
  }

  private isAllowed(id: string, local: string): boolean {
    const runtime = this.runtimes.get(id)
    return runtime !== undefined && this.claimant(runtime, local) !== undefined
  }

  private onMail(id: string, local: string, draft: DraftMessage): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    const message = runtime.ring.push(local, draft)
    const claimant = this.claimant(runtime, local)
    if (claimant === undefined) return
    this.deps.emitMessage({
      brokerId: id,
      subscriptionId: claimant.id,
      key: local,
      payload: message,
    })
  }

  // ── the cap provider ──────────────────────────────────────────────────────

  private async exists(id: string): Promise<boolean> {
    return (await this.deps.handle.get(id)) !== null
  }

  private async info(id: string): Promise<BrokerInfo | null> {
    const row = await this.deps.handle.get(id)
    if (row === null) return null
    const runtime = this.runtimes.get(id)
    return {
      id,
      addonId: this.deps.addonId,
      name: row.data.name,
      kind: SMTP_INBOUND_KIND,
      status: runtime?.status ?? 'disconnected',
      info: {
        port: row.data.port,
        domain: row.data.domain,
        recipients:
          runtime === undefined
            ? 0
            : [...runtime.subscriptions.values()].reduce((n, s) => n + s.recipients.size, 0),
      },
      lastCheckedAt: runtime?.checkedAt ?? null,
      error: runtime?.error ?? null,
    }
  }

  private async subscribe(
    brokerId: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<{ subscriptionId: string }> {
    const parsed = SmtpInboundFilterSchema.parse(filter)
    const runtime = this.runtimes.get(brokerId)
    if (runtime === undefined) throw new Error(`smtp-inbound: no mailbox '${brokerId}' is running`)
    const subscriberId = parsed.subscriberId ?? `anon-${randomUUID().slice(0, 8)}`
    const id = `sub-${subscriberId}`
    for (const recipient of parsed.recipients) {
      const holder = this.claimant(runtime, recipient)
      if (holder !== undefined && holder.id !== id) {
        throw new Error(
          `${SMTP_RECIPIENT_CLAIMED}: '${recipient}' is already claimed by '${holder.subscriberId}'`,
        )
      }
    }
    const next = new Map(runtime.subscriptions)
    next.set(id, { id, subscriberId, recipients: new Set(parsed.recipients) })
    runtime.subscriptions = next
    return { subscriptionId: id }
  }

  /** The subscribers (camera email push) that still read one mailbox. */
  private subscriberUsers(): BrokerUserFinder {
    return {
      find: async (brokerId) =>
        [...(this.runtimes.get(brokerId)?.subscriptions.values() ?? [])].map((sub) => ({
          kind: 'subscriber',
          id: sub.subscriberId,
        })),
    }
  }

  provider(): IBrokerProvider {
    const owns = (id: string): Promise<boolean> => this.exists(id)
    return {
      list: async ({ kind }) => {
        if (kind !== undefined && kind !== SMTP_INBOUND_KIND) return []
        const page = await this.deps.handle.query({ limit: PAGE })
        const infos = await Promise.all(page.records.map((r) => this.info(r.id)))
        return infos.flatMap((i) => (i === null ? [] : [i]))
      },
      get: async ({ id }) => this.info(id),
      listProviders: async () => [
        {
          addonId: this.deps.addonId,
          kinds: [{ kind: SMTP_INBOUND_KIND, label: KIND_LABEL }],
        },
      ],
      add: async ({ kind, name, id, settings }) => {
        if (kind !== SMTP_INBOUND_KIND) {
          throw new Error(
            `smtp-nodemailer: only kind '${SMTP_INBOUND_KIND}' is handled here (got '${kind}')`,
          )
        }
        const parsed = SmtpInboundSettingsSchema.parse(settings)
        const brokerId = id ?? `smtp-inbound-${randomUUID().slice(0, 8)}`
        if (await this.exists(brokerId))
          throw new Error(`broker id '${brokerId}' is already in use`)
        const body: MailboxBody = MailboxBodySchema.parse({
          name,
          port: parsed.port,
          bindHost: parsed.bindHost,
          domain: parsed.domain,
          requireAuth: parsed.requireAuth,
          username:
            parsed.username.length > 0
              ? parsed.username
              : `camstack-${randomBytes(4).toString('hex')}`,
          password:
            parsed.password.length > 0 ? parsed.password : randomBytes(18).toString('base64url'),
          starttls: parsed.starttls,
          maxMessageBytes: parsed.maxMessageBytes,
        })
        await this.deps.handle.put({ id: brokerId, data: body }, { ifRev: 0 })
        await this.reconcile(brokerId)
        return { id: brokerId }
      },
      remove: async ({ id }) => {
        if (!(await owns(id))) return
        await assertBrokerUnused(id, [this.subscriberUsers()])
        await this.deps.handle.delete(id)
        await this.reconcile(id)
      },
      testConnection: async ({ id }) => {
        if (!(await owns(id))) return { ok: false, error: 'unknown broker' }
        const runtime = this.runtimes.get(id)
        if (runtime?.status === 'connected') return { ok: true, latencyMs: 0 }
        return {
          ok: false,
          error: runtime?.error ?? 'The mailbox is not listening',
        }
      },
      getSettings: async ({ id }) => {
        const row = await this.deps.handle.get(id)
        if (row === null) return null
        const { name: _name, password: _password, ...settings } = row.data
        return settings
      },
      setSettings: async ({ id, settings }) => {
        const row = await this.deps.handle.getResolved(id)
        if (row === null) return
        const parsed = SmtpInboundSettingsSchema.partial().parse(settings)
        const next = MailboxBodySchema.parse({
          ...row.data,
          ...Object.fromEntries(
            Object.entries(parsed).filter(([, v]) => v !== undefined && v !== ''),
          ),
        })
        await this.deps.handle.put({ id, data: next })
        await this.reconcile(id)
      },
      getBrokerConfig: async ({ id }) => {
        let row: Awaited<ReturnType<InboundBrokerDeps['handle']['getResolved']>>
        try {
          row = await this.deps.handle.getResolved(id)
        } catch (err: unknown) {
          if (err instanceof RecordSecretUnavailableError) {
            throw new Error(
              'smtp-inbound: the keychain is locked; the mailbox password cannot be read',
            )
          }
          throw err
        }
        if (row === null) return null
        const host = await this.deps.readInternalHost()
        return {
          host,
          hostReason: host === null ? NO_INTERNAL_HOST_REASON : null,
          port: row.data.port,
          domain: row.data.domain,
          requireAuth: row.data.requireAuth,
          username: row.data.username,
          password: row.data.password ?? '',
          starttls: row.data.starttls,
        }
      },
      getSettingsSchema: async ({ kind }) =>
        kind === SMTP_INBOUND_KIND ? mailboxSettingsSchema() : null,
      testSettings: async ({ kind, settings }) => {
        if (kind !== SMTP_INBOUND_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
        const parsed = SmtpInboundSettingsSchema.safeParse(settings)
        if (!parsed.success) return { ok: false, error: parsed.error.message }
        return probeBind(parsed.data.port, parsed.data.bindHost)
      },
      publish: async () => {
        throw new Error('smtp-inbound: a mailbox only receives — publish is not supported')
      },
      subscribe: async ({ brokerId, filter }) => this.subscribe(brokerId, filter),
      unsubscribe: async ({ brokerId, subscriptionId }) => {
        const runtime = this.runtimes.get(brokerId)
        if (runtime === undefined) return
        const next = new Map(runtime.subscriptions)
        next.delete(subscriptionId)
        runtime.subscriptions = next
      },
      getState: async ({ brokerId, key }) => {
        const runtime = this.runtimes.get(brokerId)
        const seq = parseSmtpSinceKey(key)
        if (runtime === undefined || seq === null) return null
        return runtime.ring.since(seq)
      },
      getStatus: async () => {
        const all = [...this.runtimes.values()]
        return {
          brokerCount: all.length,
          connectedCount: all.filter((r) => r.status === 'connected').length,
        }
      },
    }
  }
}

/** A bind probe: can this port be taken on this host right now? */
function probeBind(
  port: number,
  host: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', (err: Error) => resolve({ ok: false, error: err.message }))
    probe.listen(port, host, () => {
      probe.close(() => resolve({ ok: true, latencyMs: Date.now() - started }))
    })
  })
}

function mailboxSettingsSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'mailbox',
        title: 'Inbound mailbox',
        description:
          "A mailbox that devices (cameras) send alarm mail to. Consumers claim recipients on it; the address cameras use is the hub's Internal address (System → Network).",
        columns: 2,
        fields: [
          {
            type: 'number',
            key: 'port',
            label: 'SMTP port',
            min: 1,
            max: 65535,
            step: 1,
            default: 2525,
          },
          {
            type: 'text',
            key: 'domain',
            label: 'Virtual domain',
            default: 'camstack.local',
            description: 'Only used to build recipient addresses; never resolved through DNS.',
          },
          {
            type: 'boolean',
            key: 'requireAuth',
            label: 'Require AUTH',
            default: true,
          },
          {
            type: 'text',
            key: 'username',
            label: 'AUTH username',
            description: 'Minted when left empty.',
          },
          {
            type: 'password',
            key: 'password',
            label: 'AUTH password',
            showToggle: true,
            description: 'Minted when left empty.',
          },
          {
            type: 'text',
            key: 'bindHost',
            label: 'Bind address',
            default: '0.0.0.0',
          },
        ],
      },
    ],
  }
}
