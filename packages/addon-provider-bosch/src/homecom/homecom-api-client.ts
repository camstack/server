import type { HomeComConfig } from './config.js'
import { homeComApiBase } from './config.js'
import { parseHomeComSystemPayload } from './homecom-domain-mapping.js'
import type { HomeComDhw, HomeComHeatingCircuit } from './homecom-domain-mapping.js'
import { HOMECOM_CLIENT_ID, HOMECOM_TOKEN_URL } from './homecom-oauth.js'

export class HomeComAuthError extends Error {
  readonly name = 'HomeComAuthError'
}

export interface HomeComGatewayInfo {
  readonly gatewayId: string
  readonly name: string
  readonly model: string
}

/** One gateway (heat pump controller) on the account. */
export interface HomeComGatewayListing {
  readonly gatewayId: string
  readonly name: string
  readonly brand?: string
  readonly region?: string
}

export interface HomeComTokens {
  readonly token: string
  readonly refresh: string
}

export interface HomeComSystemSnapshot {
  readonly gateway: HomeComGatewayInfo
  readonly circuits: readonly HomeComHeatingCircuit[]
  readonly dhw: HomeComDhw | null
}

export interface HomeComApiClient {
  refreshTokens(): Promise<HomeComTokens>
  listGateways(): Promise<readonly HomeComGatewayListing[]>
  fetchSystem(): Promise<HomeComSystemSnapshot>
  setCircuitSetpoint(circuitId: string, temp: number): Promise<void>
  setCircuitMode(circuitId: string, mode: string): Promise<void>
  setDhwTarget(temp: number): Promise<void>
  setDhwMode(mode: string): Promise<void>
}

export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface HomeComApiClientDeps {
  readonly fetchFn?: FetchFn
  /** Called with every rotated pair, before the new access token is used. Must not log values. */
  readonly onTokensRotated?: (tokens: HomeComTokens) => Promise<void>
}

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

/** Gateways from the account listing: a bare array or `{ gateways: [...] }`. */
export function parseHomeComGatewayList(payload: unknown): readonly HomeComGatewayListing[] {
  const rows = isRecord(payload) ? payload['gateways'] : payload
  if (!Array.isArray(rows)) return []
  const out: HomeComGatewayListing[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const gatewayId = rowId(row)
    if (gatewayId === null) continue
    const name = row['name']
    const brand = row['brand']
    const region = row['region']
    out.push({
      gatewayId,
      name: typeof name === 'string' && name.length > 0 ? name : gatewayId,
      ...(typeof brand === 'string' && brand.length > 0 ? { brand } : {}),
      ...(typeof region === 'string' && region.length > 0 ? { region } : {}),
    })
  }
  return out
}

export function createHomeComApiClient(
  config: HomeComConfig,
  gatewayId: string,
  deps: HomeComApiClientDeps = {},
): HomeComApiClient {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis)
  let token = config.token
  let refresh = config.refresh
  const base = homeComApiBase(config.region)

  async function authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const res = await fetchFn(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: await authHeaders(),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (res.status === 401) {
      throw new HomeComAuthError('token expired')
    }
    if (!res.ok) {
      throw new Error(`HomeCom API ${path} failed: HTTP ${res.status}`)
    }
    return res.json()
  }

  return {
    async refreshTokens() {
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
      if (typeof body !== 'object' || body === null)
        throw new Error('HomeCom token refresh: bad body')
      const row = body as Record<string, unknown>
      const newToken = row['access_token']
      const newRefresh = row['refresh_token']
      if (typeof newToken !== 'string' || typeof newRefresh !== 'string') {
        throw new Error('HomeCom token refresh: missing tokens')
      }
      token = newToken
      refresh = newRefresh
      await deps.onTokensRotated?.({ token, refresh })
      return { token, refresh }
    },

    async listGateways() {
      return parseHomeComGatewayList(await request('/v2/gateways'))
    },

    async fetchSystem() {
      const payload = await request(`/v2/gateways/${gatewayId}/system`)
      const parsed = parseHomeComSystemPayload(payload)
      return {
        gateway: {
          gatewayId,
          name: 'HomeCom heat pump',
          model: 'K40',
        },
        circuits: parsed.circuits,
        dhw: parsed.dhw,
      }
    },

    async setCircuitSetpoint(circuitId, temp) {
      await request(`/v2/gateways/${gatewayId}/heatingCircuits/${circuitId}/setpoint`, {
        method: 'PUT',
        body: { value: temp },
      })
    },

    async setCircuitMode(circuitId, mode) {
      await request(`/v2/gateways/${gatewayId}/heatingCircuits/${circuitId}/operationMode`, {
        method: 'PUT',
        body: { value: mode },
      })
    },

    async setDhwTarget(temp) {
      await request(`/v2/gateways/${gatewayId}/domesticHotWater/setpoint`, {
        method: 'PUT',
        body: { value: temp },
      })
    },

    async setDhwMode(mode) {
      await request(`/v2/gateways/${gatewayId}/domesticHotWater/operationMode`, {
        method: 'PUT',
        body: { value: mode },
      })
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
      return [{ gatewayId: snapshot.gateway.gatewayId, name: snapshot.gateway.name }]
    },
    async fetchSystem() {
      if (!tokensValid) throw new HomeComAuthError('token expired')
      return snapshot
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
        snapshot = {
          ...snapshot,
          dhw: { ...snapshot.dhw, operationMode: mode },
        }
      }
    },
  }
}
