import {
  entityIndexFromDescription,
  isCurrentDescription,
  type HomeConnectCompactDescription,
} from './home-connect-device-description.js'
import {
  extractZipEntries,
  HOME_CONNECT_IDDF_URL,
  homeConnectIddfHeaders,
  parseIddfZipBuffer,
} from './home-connect-iddf.js'
import { errMsg, isSecretMarker, isSecretMarkerLike } from '@camstack/types'
import type { HomeConnectConfig, HomeConnectStoredAppliance } from './config.js'
import {
  homeConnectTokenExpiresAtMs,
  refreshHomeConnectToken,
  type HomeConnectTokenRefreshFailed,
  type LoginFetch,
} from './home-connect-login.js'

/** Refresh the access token when it expires within this window, before any IDDF fetch. */
export const HOME_CONNECT_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

export type EnrichHomeConnectLog = (message: string, meta: Record<string, unknown>) => void

export interface EnrichHomeConnectHooks {
  readonly onInfo?: EnrichHomeConnectLog
  /** A branch that leaves an appliance degraded or keeps a stale token; never carries a credential. */
  readonly onWarn?: EnrichHomeConnectLog
  readonly now?: () => number
}

export function entityCountInStoredDescription(
  description: HomeConnectStoredAppliance['deviceDescription'],
): number {
  if (description === undefined) return 0
  return entityIndexFromDescription(description).size
}

/** Why an IDDF did not load, with what the cloud answered (never the token). */
export type HomeConnectIddfFailureReason =
  | 'unauthorized'
  | 'http-error'
  | 'no-body'
  | 'unparsable-zip'
  | 'no-entities'

export interface HomeConnectIddfFetched {
  readonly ok: true
  readonly compact: HomeConnectCompactDescription
  readonly entityCount: number
}

export interface HomeConnectIddfFailed {
  readonly ok: false
  readonly reason: HomeConnectIddfFailureReason
  readonly status: number
  readonly contentType: string | null
  /** Body size in bytes; `null` when the body was not read. */
  readonly bytes: number | null
  /** ZIP entries found; `null` when the body was not read. */
  readonly zipEntries: number | null
  /** Names of the ZIP entries found (device metadata, never a credential); `null` when unread. */
  readonly zipEntryNames: readonly string[] | null
  /** First bytes of the body as hex — the format's magic; `null` when unread. */
  readonly headHex: string | null
  readonly contentEncoding: string | null
  readonly contentDisposition: string | null
  readonly entityCount: number
}

/** How many leading body bytes the unparsable-body probe logs. */
const HEAD_HEX_BYTES = 16

export type HomeConnectIddfFetchResult = HomeConnectIddfFetched | HomeConnectIddfFailed

export async function fetchHomeConnectIddf(
  haId: string,
  token: string,
  fetchImpl: LoginFetch,
): Promise<HomeConnectIddfFetchResult> {
  const response = await fetchImpl(HOME_CONNECT_IDDF_URL(haId), {
    method: 'GET',
    headers: homeConnectIddfHeaders(token),
    redirect: 'manual',
  })
  const contentType = response.headers.get('content-type')
  const headers = {
    status: response.status,
    contentType,
    contentEncoding: response.headers.get('content-encoding'),
    contentDisposition: response.headers.get('content-disposition'),
  }
  const unread = { ...headers, bytes: null, zipEntries: null, zipEntryNames: null, headHex: null }
  if (response.status === 401) {
    return { ok: false, reason: 'unauthorized', entityCount: 0, ...unread }
  }
  if (response.status >= 400) return { ok: false, reason: 'http-error', entityCount: 0, ...unread }
  if (!response.arrayBuffer) return { ok: false, reason: 'no-body', entityCount: 0, ...unread }
  const body = Buffer.from(await response.arrayBuffer())
  const compact = parseIddfZipBuffer(body, haId)
  const read = (): Omit<HomeConnectIddfFailed, 'ok' | 'reason' | 'entityCount'> => {
    const names = [...extractZipEntries(body).keys()]
    return {
      ...headers,
      bytes: body.length,
      zipEntries: names.length,
      zipEntryNames: names,
      headHex: body.subarray(0, HEAD_HEX_BYTES).toString('hex'),
    }
  }
  if (compact === null) return { ok: false, reason: 'unparsable-zip', entityCount: 0, ...read() }
  const entityCount = entityCountForCompact(compact)
  if (entityCount === 0) return { ok: false, reason: 'no-entities', entityCount, ...read() }
  return { ok: true, compact, entityCount }
}

export function compactDescriptionToStored(
  compact: HomeConnectCompactDescription,
): NonNullable<HomeConnectStoredAppliance['deviceDescription']> {
  return JSON.parse(JSON.stringify(compact))
}

function entityCountForCompact(compact: HomeConnectCompactDescription): number {
  return entityIndexFromDescription(JSON.parse(JSON.stringify(compact))).size
}

export interface EnrichHomeConnectResult {
  readonly connection: HomeConnectConfig
  /** An appliance gained an entity map in this pass. */
  readonly changed: boolean
  /** The access (and refresh) token was rotated in this pass; the connection carries it. */
  readonly tokenRotated: boolean
  /** haIds of TLS appliances that still have NO entity map after this pass (cloud fetch failed or empty). */
  readonly missing: readonly string[]
}

interface TokenState {
  token: string
  refresh: string
  rotated: boolean
  /** One refresh per pass: a refresh that failed (or a token that is 401 right after one) is not retried. */
  refreshTried: boolean
}

function refreshFailureMeta(failure: HomeConnectTokenRefreshFailed): Record<string, unknown> {
  return {
    reason: `refresh-${failure.reason}`,
    status: failure.status,
    ...(failure.error !== undefined ? { error: failure.error } : {}),
  }
}

/** Refresh once; on failure the state is untouched (D49) and the reason is logged. */
async function refreshOnce(
  state: TokenState,
  trigger: 'expired' | 'unauthorized',
  fetchImpl: LoginFetch,
  hooks: EnrichHomeConnectHooks,
): Promise<boolean> {
  if (state.refreshTried) return false
  state.refreshTried = true
  const result = await refreshHomeConnectToken(state.refresh, fetchImpl)
  if (!result.ok) {
    hooks.onWarn?.('Home Connect access token refresh failed — keeping the stored token', {
      trigger,
      ...refreshFailureMeta(result),
    })
    return false
  }
  state.token = result.token
  state.refresh = result.refresh
  state.rotated = true
  hooks.onInfo?.('Home Connect access token refreshed', { trigger })
  return true
}

function tokenNeedsRefresh(token: string, now: number): boolean {
  const expiresAt = homeConnectTokenExpiresAtMs(token)
  return expiresAt !== null && expiresAt - now <= HOME_CONNECT_TOKEN_REFRESH_MARGIN_MS
}

async function fetchWithRefresh(
  haId: string,
  state: TokenState,
  fetchImpl: LoginFetch,
  hooks: EnrichHomeConnectHooks,
): Promise<HomeConnectIddfFetchResult> {
  const first = await fetchHomeConnectIddf(haId, state.token, fetchImpl)
  if (first.ok || first.reason !== 'unauthorized') return first
  if (!(await refreshOnce(state, 'unauthorized', fetchImpl, hooks))) return first
  return fetchHomeConnectIddf(haId, state.token, fetchImpl)
}

function failureMeta(failure: HomeConnectIddfFailed): Record<string, unknown> {
  return {
    reason: failure.reason,
    status: failure.status,
    contentType: failure.contentType,
    bytes: failure.bytes,
    zipEntries: failure.zipEntries,
    zipEntryNames: failure.zipEntryNames,
    headHex: failure.headHex,
    contentEncoding: failure.contentEncoding,
    contentDisposition: failure.contentDisposition,
    entityCount: failure.entityCount,
  }
}

/**
 * Fill missing or outdated IDDF entity maps on stored appliances (TLS first).
 * An access token at or near its expiry is refreshed first, and a 401 refreshes once and
 * retries; a rotated pair is returned on the connection (`tokenRotated`) for the caller to
 * persist. A failed refresh changes nothing (D49).
 * An appliance whose IDDF cannot be fetched keeps whatever it had and is listed in
 * `missing` so the caller can retry — the entity map of ANOTHER model is never
 * substituted: the UIDs differ per model and a wrong map decodes values into the
 * wrong features.
 */
export async function enrichHomeConnectConnection(
  connection: HomeConnectConfig,
  fetchImpl: LoginFetch,
  hooks: EnrichHomeConnectHooks = {},
): Promise<EnrichHomeConnectResult> {
  const appliances = connection.appliances ?? []
  if (appliances.length === 0) {
    return { connection, changed: false, tokenRotated: false, missing: [] }
  }
  const token = connection.token
  if (isSecretMarker(token) || isSecretMarkerLike(token)) {
    return { connection, changed: false, tokenRotated: false, missing: unmapped(appliances) }
  }
  const refreshStored = connection.refresh ?? ''
  const state: TokenState = {
    token,
    refresh:
      isSecretMarker(refreshStored) || isSecretMarkerLike(refreshStored) ? '' : refreshStored,
    rotated: false,
    refreshTried: false,
  }

  const pending = appliances.filter(
    (row) => row.mode === 'TLS' && !isCurrentDescription(row.deviceDescription),
  )
  if (pending.length > 0 && tokenNeedsRefresh(state.token, (hooks.now ?? Date.now)())) {
    await refreshOnce(state, 'expired', fetchImpl, hooks)
  }

  let changed = false
  const nextAppliances: HomeConnectStoredAppliance[] = []
  for (const row of appliances) {
    if (!pending.includes(row)) {
      nextAppliances.push(row)
      continue
    }
    let result: HomeConnectIddfFetchResult | null = null
    try {
      result = await fetchWithRefresh(row.haId, state, fetchImpl, hooks)
    } catch (err: unknown) {
      hooks.onWarn?.('Home Connect IDDF fetch failed', { haId: row.haId, error: errMsg(err) })
    }
    if (result === null || !result.ok) {
      hooks.onWarn?.('Home Connect IDDF unavailable — appliance stays degraded until it loads', {
        haId: row.haId,
        ...(result === null ? { reason: 'fetch-threw' } : failureMeta(result)),
      })
      nextAppliances.push(row)
      continue
    }
    changed = true
    hooks.onInfo?.('Home Connect IDDF loaded', { haId: row.haId, entityCount: result.entityCount })
    nextAppliances.push({ ...row, deviceDescription: compactDescriptionToStored(result.compact) })
  }

  const withAppliances = changed ? { ...connection, appliances: nextAppliances } : connection
  const next = state.rotated
    ? { ...withAppliances, token: state.token, refresh: state.refresh }
    : withAppliances
  return {
    connection: next,
    changed,
    tokenRotated: state.rotated,
    missing: unmapped(nextAppliances),
  }
}

function unmapped(appliances: readonly HomeConnectStoredAppliance[]): readonly string[] {
  return appliances
    .filter((a) => a.mode === 'TLS' && entityCountInStoredDescription(a.deviceDescription) === 0)
    .map((a) => a.haId)
}
