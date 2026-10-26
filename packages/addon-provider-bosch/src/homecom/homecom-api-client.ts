import type { IScopedLogger } from '@camstack/types'
import type { HomeComConfig } from './config.js'
import { HOMECOM_GATEWAYS_PATH, HOMECOM_POINTT_API_ORIGIN, homeComApiBase } from './config.js'
import {
  familyOf,
  HomeComUnknownDeviceTypeError,
  type HomeComResourceFamily,
} from './homecom-device-type.js'
import { HOMECOM_CLIENT_ID, HOMECOM_TOKEN_URL } from './homecom-oauth.js'
import {
  circuitModeWrites,
  circuitSetpointWrite,
  dhwModeWrite,
  dhwTargetWrite,
  fanWrite,
  HOMECOM_PROBE_CLOCK,
  HOMECOM_PROBE_FIRMWARE,
  probeText,
  readPointtSnapshot,
  swingWrite,
  type PointtWrite,
} from './homecom-pointt.js'
import type { HomeComDhw, HomeComHeatingCircuit } from './homecom-domain-mapping.js'

export { HomeComUnknownDeviceTypeError } from './homecom-device-type.js'

export class HomeComAuthError extends Error {
  readonly name = 'HomeComAuthError'
}

/** The account gateway list answered with an HTTP error. The status is the point. */
export class HomeComGatewayListError extends Error {
  readonly name = 'HomeComGatewayListError'
  readonly status: number
  constructor(status: number) {
    super(`The gateway list failed (HTTP ${status}).`)
    this.status = status
  }
}

export interface HomeComGatewayInfo {
  readonly gatewayId: string
  readonly name: string
  readonly model: string
}

/** One gateway on the account. `deviceType` selects the resource tree. */
export interface HomeComGatewayListing {
  readonly gatewayId: string
  readonly name: string
  readonly model?: string
  readonly serial?: string
  readonly brand?: string
  readonly region?: string
  readonly deviceType?: string
}

export interface HomeComTokens {
  readonly token: string
  readonly refresh: string
}

export interface HomeComSystemSnapshot {
  readonly gateway: HomeComGatewayInfo
  readonly circuits: readonly HomeComHeatingCircuit[]
  readonly dhw: HomeComDhw | null
  readonly deviceType?: string
  readonly family?: HomeComResourceFamily
}

export interface HomeComProbeResult {
  readonly resource: string
  readonly value: string
}

export interface HomeComApiClient {
  refreshTokens(): Promise<HomeComTokens>
  listGateways(): Promise<readonly HomeComGatewayListing[]>
  fetchSystem(): Promise<HomeComSystemSnapshot>
  /** Cheap read for the connection test. Never refreshes the token. */
  probeGateway(): Promise<HomeComProbeResult>
  setCircuitSetpoint(circuitId: string, temp: number): Promise<void>
  setCircuitMode(circuitId: string, mode: string): Promise<void>
  setDhwTarget(temp: number): Promise<void>
  setDhwMode(mode: string): Promise<void>
  setFanMode(circuitId: string, fanMode: string): Promise<void>
  setSwingVertical(circuitId: string, on: boolean): Promise<void>
  setSwingHorizontal(circuitId: string, on: boolean): Promise<void>
}

export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface HomeComApiClientDeps {
  readonly fetchFn?: FetchFn
  /** Called with every rotated pair, before the new access token is used. Must not log values. */
  readonly onTokensRotated?: (tokens: HomeComTokens) => Promise<void>
  /** When false, a 401 is named and not refreshed. The connection test uses this. */
  readonly refreshOnUnauthorized?: boolean
  /** Device type from the gateway list, so a read does not list the account again. */
  readonly deviceType?: string
  readonly logger?: Pick<IScopedLogger, 'info' | 'warn'>
}

interface AuthedResult {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

type Attempt = 'first' | 'retried'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rowId(row: Record<string, unknown>): string | null {
  for (const key of ['deviceId', 'gatewayId', 'id']) {
    const value = row[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

function textOf(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

/** Gateways from the account listing: a bare array or `{ gateways: [...] }`. */
export function parseHomeComGatewayList(payload: unknown): readonly HomeComGatewayListing[] {
  const rows = isRecord(payload) ? payload['gateways'] : payload
  if (!Array.isArray(rows)) return []
  const out: HomeComGatewayListing[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const gatewayId = rowId(row)
    if (gatewayId === null) continue
    const name = textOf(row, ['name', 'friendlyName'])
    const deviceType = textOf(row, ['deviceType'])
    const model = textOf(row, ['model']) ?? deviceType
    const serial = textOf(row, ['serial', 'serialNumber', 'serialId'])
    const brand = textOf(row, ['brand'])
    const region = textOf(row, ['region'])
    out.push({
      gatewayId,
      name: name ?? gatewayId,
      ...(model !== undefined ? { model } : {}),
      ...(serial !== undefined ? { serial } : {}),
      ...(brand !== undefined ? { brand } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(deviceType !== undefined ? { deviceType } : {}),
    })
  }
  return out
}

export function homeComResourceUrl(gatewayId: string, resourcePath: string): string {
  const path = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`
  return `${HOMECOM_POINTT_API_ORIGIN}${HOMECOM_GATEWAYS_PATH}${encodeURIComponent(gatewayId)}/resource${path}`
}

export function createHomeComApiClient(
  config: HomeComConfig,
  gatewayId: string,
  deps: HomeComApiClientDeps = {},
): HomeComApiClient {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis)
  const refreshOnUnauthorized = deps.refreshOnUnauthorized ?? true
  const logger = deps.logger
  let token = config.token
  let refresh = config.refresh
  let deviceType = deps.deviceType
  let last: HomeComSystemSnapshot | null = null
  let refreshTail: Promise<void> = Promise.resolve()
  const dropped = new Set<string>()
  const base = homeComApiBase(config.region)

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
  }

  function logDrop(reason: string): void {
    if (dropped.has(reason)) return
    dropped.add(reason)
    logger?.info('HomeCom dropped a resource the caps do not publish', {
      meta: { gatewayId, deviceType: deviceType ?? '(missing)', reason },
    })
  }

  function logMissing(path: string, status: number): void {
    const key = `missing:${path}`
    if (dropped.has(key)) return
    dropped.add(key)
    logger?.info('HomeCom resource is absent', { meta: { gatewayId, path, status } })
  }

  async function refreshIfStale(used: string): Promise<void> {
    const run = refreshTail.then(async () => {
      if (token !== used) return
      await refreshTokens()
    })
    refreshTail = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async function authed(
    url: string,
    init: { method?: string; body?: string; allowRefresh?: boolean },
    attempt: Attempt = 'first',
  ): Promise<AuthedResult> {
    const used = token
    const res = await fetchFn(url, {
      method: init.method ?? 'GET',
      headers: authHeaders(),
      body: init.body,
    })
    if (res.status === 401) {
      const allow = (init.allowRefresh ?? true) && refreshOnUnauthorized
      if (!allow || attempt === 'retried') {
        throw new HomeComAuthError(
          attempt === 'retried' ? 'token expired after refresh' : 'token expired',
        )
      }
      await refreshIfStale(used)
      return authed(url, init, 'retried')
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  }

  async function getResource(path: string): Promise<unknown | null> {
    const res = await authed(homeComResourceUrl(gatewayId, path), { method: 'GET' })
    if (res.status === 404 || res.status === 403) {
      logMissing(path, res.status)
      return null
    }
    if (!res.ok) throw new Error(`HomeCom API ${path} failed: HTTP ${res.status}`)
    return res.body
  }

  async function putWrite(write: PointtWrite): Promise<void> {
    const res = await authed(homeComResourceUrl(gatewayId, write.path), {
      method: 'PUT',
      body: JSON.stringify({ value: write.value }),
    })
    if (res.status === 404 || res.status === 403) {
      throw new Error(`HomeCom write to ${write.path} was refused (HTTP ${res.status}).`)
    }
    if (!res.ok) throw new Error(`HomeCom API ${write.path} failed: HTTP ${res.status}`)
  }

  async function requireSnapshot(): Promise<HomeComSystemSnapshot> {
    if (last !== null) return last
    return fetchSystem()
  }

  async function resolveDeviceType(): Promise<{
    deviceType: string
    family: HomeComResourceFamily
  }> {
    if (deviceType === undefined) {
      const rows = await listGateways()
      deviceType = rows.find((row) => row.gatewayId === gatewayId)?.deviceType
    }
    const family = familyOf(deviceType)
    if (family === null || deviceType === undefined) {
      const label = deviceType ?? '(missing)'
      logger?.warn('HomeCom device type is not served', { meta: { gatewayId, deviceType: label } })
      throw new HomeComUnknownDeviceTypeError(label)
    }
    return { deviceType, family }
  }

  async function refreshTokens(): Promise<HomeComTokens> {
    const res = await fetchFn(HOMECOM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: HOMECOM_CLIENT_ID,
      }).toString(),
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new HomeComAuthError('refresh refused')
      throw new Error(`HomeCom token refresh failed: HTTP ${res.status}`)
    }
    const body: unknown = await res.json()
    if (!isRecord(body)) throw new Error('HomeCom token refresh: bad body')
    const newToken = body['access_token']
    const newRefresh = body['refresh_token']
    if (typeof newToken !== 'string' || typeof newRefresh !== 'string') {
      throw new Error('HomeCom token refresh: missing tokens')
    }
    token = newToken
    refresh = newRefresh
    await deps.onTokensRotated?.({ token, refresh })
    return { token, refresh }
  }

  async function listGateways(): Promise<readonly HomeComGatewayListing[]> {
    const res = await authed(`${base}${HOMECOM_GATEWAYS_PATH}`, { method: 'GET' })
    if (!res.ok) throw new HomeComGatewayListError(res.status)
    return parseHomeComGatewayList(res.body)
  }

  async function fetchSystem(): Promise<HomeComSystemSnapshot> {
    const resolved = await resolveDeviceType()
    const snapshot = await readPointtSnapshot({
      deviceType: resolved.deviceType,
      family: resolved.family,
      gatewayId,
      get: getResource,
      logDrop,
    })
    last = snapshot
    return snapshot
  }

  async function probePath(path: string): Promise<string | null> {
    const res = await authed(homeComResourceUrl(gatewayId, path), {
      method: 'GET',
      allowRefresh: false,
    })
    if (res.status === 404 || res.status === 403) return null
    if (!res.ok) throw new Error(`HomeCom API ${path} failed: HTTP ${res.status}`)
    return probeText(res.body)
  }

  return {
    refreshTokens,
    listGateways,
    fetchSystem,
    async probeGateway() {
      const clock = await probePath(HOMECOM_PROBE_CLOCK)
      if (clock !== null) return { resource: HOMECOM_PROBE_CLOCK, value: clock }
      const firmware = await probePath(HOMECOM_PROBE_FIRMWARE)
      if (firmware !== null) return { resource: HOMECOM_PROBE_FIRMWARE, value: firmware }
      throw new Error(
        `HomeCom gateway ${gatewayId} did not answer /gateway/DateTime or /gateway/versionFirmware.`,
      )
    },
    async setCircuitSetpoint(circuitId, temp) {
      await putWrite(circuitSetpointWrite(await requireSnapshot(), circuitId, temp))
    },
    async setCircuitMode(circuitId, mode) {
      for (const write of circuitModeWrites(await requireSnapshot(), circuitId, mode)) {
        await putWrite(write)
      }
    },
    async setDhwTarget(temp) {
      await putWrite(dhwTargetWrite(await requireSnapshot(), temp))
    },
    async setDhwMode(mode) {
      await putWrite(dhwModeWrite(await requireSnapshot(), mode))
    },
    async setFanMode(_circuitId, fanMode) {
      const snapshot = await requireSnapshot()
      if (snapshot.family !== 'rac') logDrop('fan mode is not a resource on this device type')
      await putWrite(fanWrite(snapshot, fanMode))
    },
    async setSwingVertical(_circuitId, on) {
      const snapshot = await requireSnapshot()
      if (snapshot.family !== 'rac') logDrop('swing is not a resource on this device type')
      await putWrite(swingWrite(snapshot, 'vertical', on))
    },
    async setSwingHorizontal(_circuitId, on) {
      const snapshot = await requireSnapshot()
      if (snapshot.family !== 'rac') logDrop('swing is not a resource on this device type')
      await putWrite(swingWrite(snapshot, 'horizontal', on))
    },
  }
}

/** In-memory fake for tests — records mutations. */
export function createInMemoryHomeComApiClient(input: {
  readonly snapshot: HomeComSystemSnapshot
  readonly tokensValid?: boolean
}): HomeComApiClient & {
  readonly mutations: { path: string; body: unknown }[]
} {
  const mutations: { path: string; body: unknown }[] = []
  let snapshot = input.snapshot
  const tokensValid = input.tokensValid ?? true

  return {
    mutations,
    async refreshTokens() {
      if (!tokensValid) throw new HomeComAuthError('refresh refused')
      return { token: 'new-access', refresh: 'new-refresh' }
    },
    async listGateways() {
      if (!tokensValid) throw new HomeComAuthError('token expired')
      return [
        {
          gatewayId: snapshot.gateway.gatewayId,
          name: snapshot.gateway.name,
          deviceType: 'k40',
        },
      ]
    },
    async fetchSystem() {
      if (!tokensValid) throw new HomeComAuthError('token expired')
      return snapshot
    },
    async probeGateway() {
      if (!tokensValid) throw new HomeComAuthError('token expired')
      return { resource: '/gateway/DateTime', value: '2024-01-01T00:00:00' }
    },
    async setCircuitSetpoint(circuitId, temp) {
      mutations.push({ path: `hc/${circuitId}/setpoint`, body: temp })
      snapshot = {
        ...snapshot,
        circuits: snapshot.circuits.map((c) => (c.id === circuitId ? { ...c, setpoint: temp } : c)),
      }
    },
    async setCircuitMode(circuitId, mode) {
      mutations.push({ path: `hc/${circuitId}/mode`, body: mode })
      snapshot = {
        ...snapshot,
        circuits: snapshot.circuits.map((c) =>
          c.id === circuitId ? { ...c, operationMode: mode } : c,
        ),
      }
    },
    async setDhwTarget(temp) {
      mutations.push({ path: 'dhw/setpoint', body: temp })
      if (snapshot.dhw) {
        snapshot = { ...snapshot, dhw: { ...snapshot.dhw, targetTemp: temp } }
      }
    },
    async setDhwMode(mode) {
      mutations.push({ path: 'dhw/mode', body: mode })
      if (snapshot.dhw) {
        snapshot = { ...snapshot, dhw: { ...snapshot.dhw, operationMode: mode } }
      }
    },
    async setFanMode() {
      throw new Error('HomeCom climate: fan mode not supported')
    },
    async setSwingVertical() {
      throw new Error('HomeCom climate: swing not supported')
    },
    async setSwingHorizontal() {
      throw new Error('HomeCom climate: swing not supported')
    },
  }
}
