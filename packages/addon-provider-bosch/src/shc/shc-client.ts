import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { ShcConfig } from './config.js'
import { parseShcDeviceList, parseShcRoomList } from './shc-parse-devices.js'
import { shcEventsFromPayload } from './shc-events.js'
import type { ShcDeviceSummary, ShcEventNotification, ShcRoomSummary } from './shc-types.js'

const REST_PORT = 8444
const REST_PREFIX = '/smarthome'
const RPC_PATH = '/remote/json-rpc'
const LONG_POLL_SECONDS = 30

export type ShcFetch = (
  url: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>

export interface ShcClientDeps {
  readonly fetchImpl?: ShcFetch
  readonly createAgent?: (config: ShcConfig) => Agent
}

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

  constructor(config: ShcConfig, deps: ShcClientDeps = {}) {
    this.#config = config
    this.#agent = deps.createAgent?.(config) ?? createDefaultAgent(config)
    this.#fetch = deps.fetchImpl ?? ((url, init) => fetchWithShcAgent(url, this.#agent, init))
  }

  onStateChange(handler: ShcStateChangeHandler): () => void {
    this.#stateHandlers.add(handler)
    return () => {
      this.#stateHandlers.delete(handler)
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
        while (this.#longPollRunning) {
          const payload = await this.pollSubscribed(subscriptionId)
          this.dispatchEvents(payload)
        }
      } catch (err: unknown) {
        if (this.#longPollRunning && !isAbortError(err)) {
          await sleep(2_000)
        }
      } finally {
        const subscriptionId = this.#subscriptionId
        this.#subscriptionId = null
        if (subscriptionId !== null) {
          await this.unsubscribeEvents(subscriptionId).catch(() => undefined)
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
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
