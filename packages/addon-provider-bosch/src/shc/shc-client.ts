import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { ShcConfig } from './config.js'
import { parseShcDeviceList, parseShcRoomList } from './shc-parse-devices.js'
import { shcEventsFromPayload } from './shc-events.js'
import type { ShcDeviceSummary, ShcEventNotification, ShcRoomSummary } from './shc-types.js'

const REST_PORT = 8444
const REST_PREFIX = '/smarthome'
const RPC_PATH = '/remote/json-rpc'
const LONG_POLL_SECONDS = 30
/** Slack on top of one long-poll window before undici gives up on a silent peer. */
const POLL_MARGIN_SECONDS = 15
const POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + POLL_MARGIN_SECONDS) * 1000
/** Consecutive failed RPCs that confirm the link is down (one blip never does, D49). */
export const SHC_LINK_DOWN_FAILURES = 2
/** No successful reply for this long confirms the link down on the next failure. */
export const SHC_LINK_DOWN_AFTER_MS = 2 * POLL_TIMEOUT_MS
const RETRY_DELAY_MS = 2_000

export type ShcFetch = (
  url: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>

export interface ShcClientDeps {
  readonly fetchImpl?: ShcFetch
  readonly createAgent?: (config: ShcConfig) => Agent
  /** Wait between failed RPCs of the keepalive loop (default 2 s). */
  readonly retryDelayMs?: number
  /** Clock seam for the "no successful reply for a while" rule. */
  readonly now?: () => number
  /** Called for every failed subscribe / longPoll, with the running failure count. */
  readonly onPollError?: (err: unknown, consecutiveFailures: number) => void
}

export interface ShcLinkDetail {
  readonly consecutiveFailures: number
  /** Milliseconds since the last successful reply; null when none ever came. */
  readonly sinceLastSuccessMs: number | null
  readonly error: unknown
}

/** `up` is true on every successful reply, false once per confirmed outage. */
export type ShcLinkStateHandler = (up: boolean, detail: ShcLinkDetail | null) => void

export type ShcStateChangeHandler = (event: ShcEventNotification) => void

/**
 * Local REST + long-poll client for Bosch Smart Home Controller.
 * Uses mTLS (client cert + key) on port 8444. State changes arrive on the
 * JSON-RPC long poll (`RE/subscribe` + `RE/longPoll`), not a separate port.
 */
export class ShcClient {
  readonly #config: ShcConfig
  readonly #fetch: ShcFetch
  readonly #agent: Agent

  #longPollAbort: AbortController | null = null
  #longPollRunning = false
  #subscriptionId: string | null = null
  #stateHandlers: Set<ShcStateChangeHandler> = new Set()
  #linkHandlers: Set<ShcLinkStateHandler> = new Set()
  readonly #retryDelayMs: number
  readonly #now: () => number
  readonly #onPollError: ((err: unknown, consecutiveFailures: number) => void) | undefined
  #consecutiveFailures = 0
  #lastSuccessAt: number | null = null
  #linkReportedDown = false

  constructor(config: ShcConfig, deps: ShcClientDeps = {}) {
    this.#config = config
    this.#retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS
    this.#now = deps.now ?? Date.now
    this.#onPollError = deps.onPollError
    this.#agent = deps.createAgent?.(config) ?? createDefaultAgent(config)
    this.#fetch = deps.fetchImpl ?? ((url, init) => fetchWithShcAgent(url, this.#agent, init))
  }

  onStateChange(handler: ShcStateChangeHandler): () => void {
    this.#stateHandlers.add(handler)
    return () => {
      this.#stateHandlers.delete(handler)
    }
  }

  onLinkState(handler: ShcLinkStateHandler): () => void {
    this.#linkHandlers.add(handler)
    return () => {
      this.#linkHandlers.delete(handler)
    }
  }

  restBaseUrl(): string {
    return `https://${this.#config.host}:${REST_PORT}${REST_PREFIX}`
  }

  rpcUrl(): string {
    return `https://${this.#config.host}:${REST_PORT}${RPC_PATH}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = this.#config.token?.trim()
    if (token !== undefined && token.length > 0) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }

  async listDevices(): Promise<ShcDeviceSummary[]> {
    const res = await this.#fetch(`${this.restBaseUrl()}/devices`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) {
      throw new Error(`SHC listDevices failed: HTTP ${res.status}`)
    }
    const body: unknown = await res.json()
    return parseShcDeviceList(body)
  }

  async listRooms(): Promise<ShcRoomSummary[]> {
    const res = await this.#fetch(`${this.restBaseUrl()}/rooms`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) {
      throw new Error(`SHC listRooms failed: HTTP ${res.status}`)
    }
    const body: unknown = await res.json()
    return parseShcRoomList(body)
  }

  async getServiceState<T>(deviceId: string, serviceId: string): Promise<T> {
    const res = await this.#fetch(
      `${this.restBaseUrl()}/devices/${encodeURIComponent(deviceId)}/services/${encodeURIComponent(serviceId)}/state`,
      { method: 'GET', headers: this.headers() },
    )
    if (!res.ok) {
      throw new Error(`SHC getServiceState ${serviceId} failed: HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  async putServiceState(deviceId: string, serviceId: string, body: unknown): Promise<void> {
    const res = await this.#fetch(
      `${this.restBaseUrl()}/devices/${encodeURIComponent(deviceId)}/services/${encodeURIComponent(serviceId)}/state`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      throw new Error(`SHC putServiceState ${serviceId} failed: HTTP ${res.status}`)
    }
  }

  async getHeatingSchedules(deviceId: string): Promise<unknown> {
    const res = await this.#fetch(
      `${this.restBaseUrl()}/climate/schedule/${encodeURIComponent(deviceId)}/HEATING`,
      { method: 'GET', headers: this.headers() },
    )
    if (!res.ok) {
      throw new Error(`SHC getHeatingSchedules failed: HTTP ${res.status}`)
    }
    return await res.json()
  }

  async activateHeatingSchedule(deviceId: string, scheduleId: string): Promise<void> {
    const res = await this.#fetch(
      `${this.restBaseUrl()}/climate/schedule/${encodeURIComponent(deviceId)}/${encodeURIComponent(scheduleId)}/activate`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: '',
      },
    )
    if (!res.ok) {
      throw new Error(`SHC activateHeatingSchedule failed: HTTP ${res.status}`)
    }
  }

  /** Start the long-poll loop (idempotent while already running). */
  startLongPoll(): void {
    if (this.#longPollRunning) return
    this.#longPollRunning = true
    void this.runLongPollLoop()
  }

  stopLongPoll(): void {
    this.#longPollRunning = false
    this.#longPollAbort?.abort()
    this.#longPollAbort = null
  }

  close(): void {
    this.stopLongPoll()
    this.#stateHandlers.clear()
    this.#linkHandlers.clear()
  }

  private markLinkUp(): void {
    this.#consecutiveFailures = 0
    this.#lastSuccessAt = this.#now()
    this.#linkReportedDown = false
    for (const handler of this.#linkHandlers) handler(true, null)
  }

  private markPollFailure(err: unknown): void {
    this.#consecutiveFailures += 1
    this.#onPollError?.(err, this.#consecutiveFailures)
    const sinceLastSuccessMs =
      this.#lastSuccessAt === null ? null : this.#now() - this.#lastSuccessAt
    const confirmed =
      this.#consecutiveFailures >= SHC_LINK_DOWN_FAILURES ||
      (sinceLastSuccessMs !== null && sinceLastSuccessMs >= SHC_LINK_DOWN_AFTER_MS)
    if (!confirmed || this.#linkReportedDown) return
    this.#linkReportedDown = true
    const detail: ShcLinkDetail = {
      consecutiveFailures: this.#consecutiveFailures,
      sinceLastSuccessMs,
      error: err,
    }
    for (const handler of this.#linkHandlers) handler(false, detail)
  }

  private emitState(event: ShcEventNotification): void {
    for (const handler of this.#stateHandlers) {
      handler(event)
    }
  }

  private async runLongPollLoop(): Promise<void> {
    while (this.#longPollRunning) {
      try {
        const subscriptionId = await this.subscribeEvents()
        this.#subscriptionId = subscriptionId
        this.markLinkUp()
        while (this.#longPollRunning) {
          const payload = await this.pollSubscribed(subscriptionId)
          this.markLinkUp()
          this.dispatchEvents(payload)
        }
      } catch (err: unknown) {
        if (this.#longPollRunning && !isAbortError(err)) {
          this.markPollFailure(err)
          await sleep(this.#retryDelayMs)
        }
      } finally {
        const subscriptionId = this.#subscriptionId
        this.#subscriptionId = null
        if (subscriptionId !== null) {
          // Not awaited: against a dead peer this would stall the retry for a full timeout.
          void this.unsubscribeEvents(subscriptionId).catch(() => undefined)
        }
      }
    }
  }

  private async subscribeEvents(): Promise<string> {
    const body = await this.rpc({
      jsonrpc: '2.0',
      method: 'RE/subscribe',
      params: ['com/bosch/sh/remote/*', null],
    })
    const result = body['result']
    if (typeof result !== 'string' || result.length === 0) {
      throw new Error('SHC subscribe returned no subscription id')
    }
    return result
  }

  private async pollSubscribed(subscriptionId: string): Promise<unknown> {
    return await this.rpc({
      jsonrpc: '2.0',
      method: 'RE/longPoll',
      params: [subscriptionId, LONG_POLL_SECONDS],
    })
  }

  private async unsubscribeEvents(subscriptionId: string): Promise<void> {
    await this.rpc({
      jsonrpc: '2.0',
      method: 'RE/unsubscribe',
      params: [subscriptionId],
    })
  }

  private async rpc(body: {
    readonly jsonrpc: '2.0'
    readonly method: string
    readonly params: readonly unknown[]
  }): Promise<Record<string, unknown>> {
    this.#longPollAbort = new AbortController()
    const res = await this.#fetch(this.rpcUrl(), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.#longPollAbort.signal,
    })
    if (!res.ok) {
      throw new Error(`SHC ${body.method} failed: HTTP ${res.status}`)
    }
    const payload: unknown = await res.json()
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`SHC ${body.method} returned an empty body`)
    }
    const record = payload as Record<string, unknown>
    if (record['error'] !== undefined && record['error'] !== null) {
      throw new Error(`SHC ${body.method} failed`)
    }
    return record
  }

  private dispatchEvents(payload: unknown): void {
    for (const event of shcEventsFromPayload(payload)) {
      this.emitState(event)
    }
  }
}

/**
 * Documented type boundary: undici `fetch` returns a Response-compatible body for
 * the subset ShcClient uses (`ok`, `status`, `json`, headers).
 */
async function fetchWithShcAgent(url: string, agent: Agent, init?: RequestInit): Promise<Response> {
  const undiciInit: UndiciRequestInit = {
    method: init?.method,
    headers: init?.headers as UndiciRequestInit['headers'],
    body: init?.body as UndiciRequestInit['body'],
    signal: init?.signal as UndiciRequestInit['signal'],
    dispatcher: agent,
  }
  const res = await undiciFetch(url, undiciInit)
  return res as Response
}

/** Controller presents a self-signed chain — verify would always fail (SELF_SIGNED_CERT_IN_CHAIN). */
export function shcTlsConnectOptions(config: ShcConfig): {
  readonly cert: string
  readonly key: string
  readonly rejectUnauthorized: false
} {
  return {
    cert: config.sslCertificate,
    key: config.sslKey,
    rejectUnauthorized: false,
  }
}

function createDefaultAgent(config: ShcConfig): Agent {
  return new Agent({
    connect: shcTlsConnectOptions(config),
    // A dead peer must surface within one poll window plus margin, not undici's 300 s.
    headersTimeout: POLL_TIMEOUT_MS,
    bodyTimeout: POLL_TIMEOUT_MS,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
    // not-a-state-poll: backoff sleep of the SHC long-poll subscription, which is push
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
