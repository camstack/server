import { randomUUID } from 'node:crypto'
import { errMsg, type BrokerInfo, type IScopedLogger } from '@camstack/types'

type BrokerStatus = BrokerInfo['status']
import { sameConnection, type EspBrokerEntry, type EspConnection } from './config.js'
import { reconnectDelayMs } from './esphome-backoff.js'
import { espLinkHub, type EspLinkHub } from './esphome-link-hub.js'
import {
  EspLinkError,
  isPermanentFailure,
  type EspFailureReason,
  type EspLink,
  type EspLinkFactory,
} from './esphome-link.js'

/** Starts a one-shot timer and returns its cancel. Injected so the schedule is testable. */
export type EspScheduler = (run: () => void, delayMs: number) => () => void

export const ESP_BROKER_KIND = 'esphome'

/** Broker row as the `broker` cap reports it (the owning addon id is stamped by the provider). */
export interface EspBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: typeof ESP_BROKER_KIND
  readonly status: BrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

export interface EspRegistryDeps {
  readonly factory: EspLinkFactory
  readonly logger: IScopedLogger
  readonly hub?: EspLinkHub
  readonly schedule?: EspScheduler
  /** 0..1, for the reconnect jitter. */
  readonly random?: () => number
  readonly onConnected?: (brokerId: string) => void
  readonly onDisconnected?: (brokerId: string) => void
}

const defaultSchedule: EspScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

function statusForReason(reason: EspFailureReason): BrokerStatus {
  switch (reason) {
    case 'encryption-key-missing':
    case 'encryption-key-invalid':
    case 'encryption-required':
    case 'auth':
      return 'auth-failed'
    case 'refused':
    case 'timeout':
    case 'unreachable':
      return 'unreachable'
    case 'incompatible':
    case 'error':
      return 'error'
  }
}

/**
 * Remove every secret of a connection from a message. The wire library never
 * puts the key in a message, but a log or an error shown to the operator is
 * the one place a leak is permanent, so the registry does not rely on it.
 */
export function scrubSecrets(text: string, connection: Readonly<EspConnection>): string {
  let out = text
  for (const secret of [connection.noisePsk, connection.password]) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** One board: the session, its status and its own bounded reconnect loop. */
class BoardSession {
  status: BrokerStatus = 'disconnected'
  error: string | null = null
  lastCheckedAt: number | null = null
  info: Record<string, unknown> = {}

  private link: EspLink | null = null
  private unsubClose: (() => void) | null = null
  private cancelRetry: (() => void) | null = null
  private abort: AbortController | null = null
  private attempt = 0
  private stopped = true
  /** Bumped on every start/stop so a late result of an older attempt is ignored. */
  private generation = 0

  constructor(
    readonly id: string,
    public name: string,
    public connection: EspConnection,
    public integrationId: string | undefined,
    private readonly deps: Required<
      Pick<EspRegistryDeps, 'factory' | 'logger' | 'hub' | 'schedule' | 'random'>
    > &
      Pick<EspRegistryDeps, 'onConnected' | 'onDisconnected'>,
  ) {}

  get connected(): boolean {
    return this.status === 'connected'
  }

  currentLink(): EspLink | null {
    return this.link
  }

  start(): void {
    this.stopped = false
    this.attempt = 0
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.cancelRetry?.()
    this.cancelRetry = null
    this.abort?.abort()
    this.abort = null
    await this.dropLink()
    this.status = 'disconnected'
  }

  async restart(connection: EspConnection): Promise<void> {
    await this.stop()
    this.connection = connection
    this.error = null
    this.start()
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.status = 'connecting'
    this.abort = new AbortController()
    const { logger } = this.deps
    try {
      const link = await this.deps.factory.open(this.connection, this.abort.signal)
      if (this.stopped || generation !== this.generation) {
        await link.close()
        return
      }
      this.adopt(link)
    } catch (err: unknown) {
      if (this.stopped || generation !== this.generation) return
      const failure = err instanceof EspLinkError ? err : new EspLinkError('error', errMsg(err))
      this.fail(failure)
      logger.warn('esphome: board connection failed', {
        meta: { brokerId: this.id, reason: failure.reason, error: this.error },
      })
    }
  }

  private adopt(link: EspLink): void {
    this.link = link
    this.attempt = 0
    this.error = null
    this.status = 'connected'
    this.lastCheckedAt = Date.now()
    const board = link.info()
    this.info = {
      name: board.name,
      model: board.model,
      esphomeVersion: board.esphomeVersion,
      encrypted: board.encrypted,
      entityCount: link.entities().length,
    }
    this.unsubClose = link.onClose((cause) => this.onClosed(link, cause))
    this.deps.hub.attach(this.id, link)
    this.deps.logger.info('esphome: board connected', {
      meta: { brokerId: this.id, entityCount: link.entities().length },
    })
    this.deps.onConnected?.(this.id)
  }

  private onClosed(link: EspLink, cause: EspLinkError | null): void {
    if (this.link !== link) return
    this.unsubClose = null
    this.link = null
    this.deps.hub.detach(this.id)
    this.deps.onDisconnected?.(this.id)
    if (this.stopped) return
    this.fail(cause ?? new EspLinkError('unreachable', 'connection closed'))
    this.deps.logger.warn('esphome: board connection lost', {
      meta: { brokerId: this.id, reason: cause?.reason ?? 'closed', error: this.error },
    })
  }

  /** Record the failure and, unless the operator must act, schedule the next attempt. */
  private fail(failure: EspLinkError): void {
    this.status = statusForReason(failure.reason)
    this.error = scrubSecrets(failure.message, this.connection)
    this.lastCheckedAt = Date.now()
    if (isPermanentFailure(failure.reason)) return
    const delay = reconnectDelayMs(this.attempt, this.deps.random())
    this.attempt += 1
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null
      if (!this.stopped) void this.connect()
    }, delay)
  }

  private async dropLink(): Promise<void> {
    const link = this.link
    if (link === null) return
    this.unsubClose?.()
    this.unsubClose = null
    this.link = null
    this.deps.hub.detach(this.id)
    try {
      await link.close()
    } catch (err: unknown) {
      this.deps.logger.warn('esphome: closing the board session failed', {
        meta: { brokerId: this.id, error: scrubSecrets(errMsg(err), this.connection) },
      })
    }
    this.deps.onDisconnected?.(this.id)
  }
}

/** Every configured board and its live session. */
export class EspBrokerRegistry {
  private readonly sessions = new Map<string, BoardSession>()
  private readonly shared: ConstructorParameters<typeof BoardSession>[4]

  constructor(deps: EspRegistryDeps) {
    this.shared = {
      factory: deps.factory,
      logger: deps.logger,
      hub: deps.hub ?? espLinkHub,
      schedule: deps.schedule ?? defaultSchedule,
      random: deps.random ?? Math.random,
      ...(deps.onConnected !== undefined ? { onConnected: deps.onConnected } : {}),
      ...(deps.onDisconnected !== undefined ? { onDisconnected: deps.onDisconnected } : {}),
    }
  }

  /** Start a session for every persisted board. Does not wait for the boards to answer. */
  restore(entries: readonly EspBrokerEntry[]): void {
    for (const entry of entries) {
      if (this.sessions.has(entry.id)) continue
      this.startSession(entry.id, entry.name, entry.connection, entry.integrationId)
    }
  }

  async createEntry(
    name: string,
    connection: EspConnection,
    options: { readonly id?: string; readonly integrationId?: string } = {},
  ): Promise<EspBrokerEntry> {
    const id = options.id ?? `esp_${randomUUID().slice(0, 8)}`
    if (this.sessions.has(id)) throw new Error(`ESPHome board '${id}' already exists`)
    this.startSession(id, name, connection, options.integrationId)
    return {
      id,
      name,
      connection,
      ...(options.integrationId !== undefined ? { integrationId: options.integrationId } : {}),
    }
  }

  async updateEntry(id: string, connection: EspConnection): Promise<void> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown ESPHome board '${id}'`)
    await session.restart(connection)
  }

  async removeEntry(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session === undefined) return
    await session.stop()
    this.sessions.delete(id)
  }

  /** Stamp the integration FK onto a board without touching its session. */
  linkIntegration(id: string, integrationId: string): void {
    const session = this.sessions.get(id)
    if (session !== undefined) session.integrationId = integrationId
  }

  get(id: string): EspBrokerInfo | null {
    const session = this.sessions.get(id)
    return session === undefined ? null : this.describe(session)
  }

  list(): EspBrokerInfo[] {
    return [...this.sessions.values()].map((s) => this.describe(s))
  }

  getConnection(id: string): EspConnection | null {
    return this.sessions.get(id)?.connection ?? null
  }

  getLink(id: string): EspLink | null {
    return this.sessions.get(id)?.currentLink() ?? null
  }

  size(): number {
    return this.sessions.size
  }

  connectedCount(): number {
    return [...this.sessions.values()].filter((s) => s.connected).length
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) await session.stop()
    this.sessions.clear()
  }

  hasSameConnection(id: string, connection: Readonly<EspConnection>): boolean {
    const current = this.getConnection(id)
    return current !== null && sameConnection(current, connection)
  }

  private startSession(
    id: string,
    name: string,
    connection: EspConnection,
    integrationId: string | undefined,
  ): void {
    const session = new BoardSession(id, name, connection, integrationId, this.shared)
    this.sessions.set(id, session)
    session.start()
  }

  private describe(session: BoardSession): EspBrokerInfo {
    return {
      id: session.id,
      name: session.name,
      kind: ESP_BROKER_KIND,
      status: session.status,
      info: { ...session.info, host: session.connection.host, port: session.connection.port },
      lastCheckedAt: session.lastCheckedAt,
      error: session.error,
    }
  }
}
