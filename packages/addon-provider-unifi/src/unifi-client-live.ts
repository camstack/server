import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiControllerClientFactory,
  UnifiInfraPort,
  UnifiInfraSnapshot,
  UnifiInfraState,
} from './unifi-client-contract.js'

/** The console refused the API key (HTTP 401 / 403). */
export class UnifiAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnifiAuthError'
  }
}

/** A feature the UniFi OS Integration API does not offer — a refusal, never a fake success. */
export class UnifiUnsupportedError extends Error {
  readonly feature: string
  constructor(feature: string, message: string) {
    super(message)
    this.name = 'UnifiUnsupportedError'
    this.feature = feature
  }
}

/** The console answered with an unexpected status or body. */
export class UnifiApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'UnifiApiError'
    this.status = status
  }
}

/** The subset of a fetch request the client sends. */
export interface UnifiFetchInit {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** The subset of a fetch response the client reads. */
export interface UnifiFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export type UnifiFetch = (url: string, init: UnifiFetchInit) => Promise<UnifiFetchResponse>

const PAGE_LIMIT = 200
const REQUEST_TIMEOUT_MS = 15_000

const pageSchema = z.object({
  data: z.array(z.unknown()),
  totalCount: z.number().optional(),
})

const siteSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  internalReference: z.string().optional(),
})

const deviceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
  state: z.string().optional(),
  features: z.array(z.string()).optional(),
})

const portSchema = z.object({
  idx: z.number(),
  poe: z.object({ state: z.string().optional() }).nullish(),
})

const deviceDetailSchema = z.object({
  interfaces: z
    .object({ ports: z.array(portSchema).optional() })
    .partial()
    .optional(),
})

const statsSchema = z.object({
  uptimeSec: z.number().nullish(),
  cpuUtilizationPct: z.number().nullish(),
})

const clientSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  macAddress: z.string().optional(),
  ipAddress: z.string().nullish(),
  uplinkDeviceId: z.string().optional(),
})

function mapState(state: string | undefined): UnifiInfraState {
  switch (state) {
    case 'ONLINE':
      return 'online'
    case 'OFFLINE':
    case 'CONNECTION_INTERRUPTED':
    case 'ISOLATED':
      return 'offline'
    case 'PENDING_ADOPTION':
      return 'pending'
    case 'ADOPTING':
    case 'GETTING_READY':
      return 'adopting'
    case 'UPDATING':
      return 'upgrading'
    default:
      return 'unknown'
  }
}

export interface UnifiLiveClientOptions {
  readonly host: string
  readonly port: number
  readonly apiKey: string
  readonly site: string
  readonly fetchImpl: UnifiFetch
}

/**
 * Thin client over the UniFi OS Network Integration API
 * (`/proxy/network/integration/v1`), authenticated by the console's API key. Polled; the
 * last-known tables back the synchronous getters.
 */
export class UnifiLiveClient implements UnifiControllerClient {
  readonly #base: string
  readonly #apiKey: string
  readonly #siteRef: string
  readonly #fetch: UnifiFetch
  #siteId: string | null = null
  #infra = new Map<string, UnifiInfraSnapshot>()
  #clients = new Map<string, UnifiClientSnapshot>()

  constructor(options: UnifiLiveClientOptions) {
    this.#base = `https://${options.host}:${options.port}/proxy/network/integration/v1`
    this.#apiKey = options.apiKey
    this.#siteRef = options.site
    this.#fetch = options.fetchImpl
  }

  async connect(): Promise<void> {
    if (this.#apiKey === '') {
      throw new UnifiAuthError(
        'unifi: an API key is required (username + password is not supported)',
      )
    }
    const sites = (await this.#list('/sites')).map((s) => siteSchema.parse(s))
    const ref = this.#siteRef.toLowerCase()
    const match = sites.find(
      (s) => s.internalReference?.toLowerCase() === ref || s.name?.toLowerCase() === ref,
    )
    if (match === undefined) {
      throw new UnifiApiError(404, `unifi: site "${this.#siteRef}" not found on the console`)
    }
    this.#siteId = match.id
  }

  async disconnect(): Promise<void> {
    this.#siteId = null
    this.#infra = new Map()
    this.#clients = new Map()
  }

  async listInfraDevices(): Promise<readonly UnifiInfraSnapshot[]> {
    const site = this.#requireSite()
    const devices = (await this.#list(`/sites/${site}/devices`)).map((d) => deviceSchema.parse(d))
    const uplinkCounts = countByUplink(await this.#listClientRecords())
    const snapshots: UnifiInfraSnapshot[] = []
    for (const device of devices) {
      snapshots.push(await this.#snapshot(site, device, uplinkCounts))
    }
    this.#infra = new Map(snapshots.map((s) => [s.id, s]))
    return snapshots
  }

  async listClients(): Promise<readonly UnifiClientSnapshot[]> {
    const records = await this.#listClientRecords()
    const snapshots: UnifiClientSnapshot[] = []
    for (const r of records) {
      if (r.macAddress === undefined) continue
      // The Integration API lists only clients currently connected.
      snapshots.push({
        mac: r.macAddress.toLowerCase(),
        hostname: r.name ?? '',
        ip: r.ipAddress ?? null,
        connected: true,
        online: true,
      })
    }
    this.#clients = new Map(snapshots.map((s) => [s.mac, s]))
    return snapshots
  }

  getInfraDevice(id: string): UnifiInfraSnapshot | null {
    return this.#infra.get(id) ?? null
  }

  getClient(mac: string): UnifiClientSnapshot | null {
    return this.#clients.get(mac) ?? null
  }

  async setPortPoe(): Promise<void> {
    throw new UnifiUnsupportedError(
      'poe-toggle',
      'unifi: the Integration API cannot switch PoE on or off; use the port power-cycle button',
    )
  }

  async setLed(): Promise<void> {
    throw new UnifiUnsupportedError(
      'led',
      'unifi: the Integration API cannot control the device LED',
    )
  }

  async restartDevice(deviceId: string): Promise<void> {
    const site = this.#requireSite()
    await this.#post(`/sites/${site}/devices/${encodeURIComponent(deviceId)}/actions`, {
      action: 'RESTART',
    })
  }

  async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
    const site = this.#requireSite()
    await this.#post(
      `/sites/${site}/devices/${encodeURIComponent(deviceId)}/interfaces/ports/${portIdx}/actions`,
      { action: 'POWER_CYCLE' },
    )
  }

  #requireSite(): string {
    if (this.#siteId === null) throw new Error('unifi: client is not connected')
    return this.#siteId
  }

  async #snapshot(
    site: string,
    device: z.infer<typeof deviceSchema>,
    uplinkCounts: ReadonlyMap<string, number>,
  ): Promise<UnifiInfraSnapshot> {
    const state = mapState(device.state)
    const stats = await this.#optional(
      `/sites/${site}/devices/${device.id}/statistics/latest`,
      (v) => statsSchema.parse(v),
    )
    const hasPorts = device.features?.includes('switching') === true
    const detail = hasPorts
      ? await this.#optional(`/sites/${site}/devices/${device.id}`, (v) =>
          deviceDetailSchema.parse(v),
        )
      : null
    const ports: UnifiInfraPort[] = (detail?.interfaces?.ports ?? []).map((p) => ({
      idx: p.idx,
      poeCapable: p.poe !== null && p.poe !== undefined,
      poeOn: p.poe?.state === 'UP',
    }))
    return {
      id: device.id,
      name: device.name ?? device.id,
      model: device.model ?? '',
      cpuPercent: stats?.cpuUtilizationPct ?? null,
      // The Integration API reports no temperature.
      cpuTempC: null,
      clients: uplinkCounts.get(device.id) ?? 0,
      state,
      uptimeSec: stats?.uptimeSec ?? null,
      ports,
      // The Integration API reports no LED state (and cannot set it).
      ledOn: false,
      online: state === 'online',
    }
  }

  async #listClientRecords(): Promise<readonly z.infer<typeof clientSchema>[]> {
    const site = this.#requireSite()
    return (await this.#list(`/sites/${site}/clients`)).map((c) => clientSchema.parse(c))
  }

  /** A secondary read that failed or is absent yields null (never a zero); auth still throws. */
  async #optional<T>(path: string, parse: (v: unknown) => T): Promise<T | null> {
    try {
      return parse(await this.#get(path))
    } catch (err) {
      if (err instanceof UnifiAuthError) throw err
      return null
    }
  }

  async #list(path: string): Promise<readonly unknown[]> {
    const items: unknown[] = []
    for (;;) {
      const page = pageSchema.parse(
        await this.#get(`${path}?offset=${items.length}&limit=${PAGE_LIMIT}`),
      )
      items.push(...page.data)
      if (page.data.length === 0 || items.length >= (page.totalCount ?? items.length)) break
    }
    return items
  }

  async #get(path: string): Promise<unknown> {
    return this.#request(path, { method: 'GET', headers: this.#headers() })
  }

  async #post(path: string, body: Readonly<Record<string, string>>): Promise<void> {
    await this.#request(path, {
      method: 'POST',
      headers: { ...this.#headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  #headers(): Record<string, string> {
    return { 'X-API-KEY': this.#apiKey, Accept: 'application/json' }
  }

  async #request(path: string, init: UnifiFetchInit): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, init)
    if (res.status === 401 || res.status === 403) {
      throw new UnifiAuthError(`unifi: the console refused the API key (HTTP ${res.status})`)
    }
    if (!res.ok)
      throw new UnifiApiError(res.status, `unifi: ${init.method} ${path} -> HTTP ${res.status}`)
    try {
      return await res.json()
    } catch {
      return null
    }
  }
}

function countByUplink(records: readonly z.infer<typeof clientSchema>[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of records) {
    if (r.uplinkDeviceId === undefined) continue
    counts.set(r.uplinkDeviceId, (counts.get(r.uplinkDeviceId) ?? 0) + 1)
  }
  return counts
}

/** The production fetch: undici, with a verification-skipping agent only when asked. */
export function makeUndiciFetch(allowSelfSigned: boolean): UnifiFetch {
  const dispatcher = allowSelfSigned
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined
  return async (url, init) => {
    const res = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      dispatcher,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { ok: res.ok, status: res.status, json: () => res.json() }
  }
}

/** The factory the addon wires: one live client per connection. */
export const liveUnifiClientFactory: UnifiControllerClientFactory = (input) =>
  new UnifiLiveClient({
    host: input.host,
    port: input.port,
    apiKey: input.apiKey,
    site: input.site,
    fetchImpl: makeUndiciFetch(input.allowSelfSigned),
  })
