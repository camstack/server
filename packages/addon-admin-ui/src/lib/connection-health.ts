/**
 * connection-health — accurate connection/health model for the admin
 * UI's top banner.
 *
 * Why this exists: the SDK's tRPC WS keepalive (`ping` every 10s,
 * `pongTimeoutMs` 6s — see `@camstack/sdk` `system.ts`) closes the
 * socket whenever a pong misses the window. That also happens when the
 * hub is merely SLOW because cluster-wide calls are timing out against
 * a frozen agent node (proven live: `addon-widgets-source provider
 * failed { sourceId=pipeline-analytics@agent-a, "timed out after
 * 2500ms" }` and a cluster-wide `getAgentLoad` taking 4.1s stalled the
 * hub long enough to miss the pong window). The old banner mapped
 * EVERY WS close to "Server unreachable — reconnecting…", implying the
 * whole server was down while the hub was serving HTTP fine.
 *
 * The model: when the SDK reports the WS as disconnected we verify hub
 * liveness with a HUB-ONLY probe that never fans out to agent nodes —
 * `GET /health` (served from the hub's in-memory agent registry) —
 * plus an authed `GET /trpc/auth.me` round-trip, and classify:
 *
 *   - `hub-unreachable`  → the hub-only probe failed: the hub itself
 *                          is down. Only THIS state renders the
 *                          alarming "Server unreachable" banner.
 *   - `auth-expired`     → hub alive but the session token was
 *                          rejected → "Session expired" + sign-in.
 *   - `cluster-degraded` → hub alive: the live socket dropped while
 *                          the hub still answers HTTP — typically
 *                          event-loop pressure from a degraded /
 *                          frozen cluster node. Non-alarming banner,
 *                          naming the offline node(s) when the hub
 *                          reports them.
 *
 * The probe repeats while the WS stays down so the banner tracks the
 * real condition (e.g. flips to `hub-unreachable` if the hub later
 * dies for real, or back once it recovers).
 */
import { hubOrigin } from './mount'
import i18n from '../i18n/index'

export type SdkConnectionState = 'connected' | 'disconnected' | 'connecting'

export interface HubProbeResult {
  /** `GET /health` answered 2xx with a healthy hub body. */
  readonly hubReachable: boolean
  /**
   * Verdict of the authed `GET /trpc/auth.me` probe. `'unknown'` when
   * there is no token, the hub was unreachable, or the probe failed
   * for a non-auth reason (network blip) — never treat unknown as
   * expired.
   */
  readonly authOk: boolean | 'unknown'
  /** Offline agent count from the `/health` body, `null` when unavailable. */
  readonly offlineAgents: number | null
  /** Offline agent node ids (newer hubs only), `null` when unavailable. */
  readonly offlineAgentIds: readonly string[] | null
}

export type ConnectionHealth =
  | { readonly kind: 'connected' }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'hub-unreachable' }
  | { readonly kind: 'auth-expired' }
  | {
      readonly kind: 'cluster-degraded'
      readonly offlineAgents: number | null
      readonly offlineAgentIds: readonly string[] | null
    }

// ─── Pure classification ────────────────────────────────────────────

export function classifyProbe(probe: HubProbeResult): ConnectionHealth {
  if (!probe.hubReachable) return { kind: 'hub-unreachable' }
  if (probe.authOk === false) return { kind: 'auth-expired' }
  return {
    kind: 'cluster-degraded',
    offlineAgents: probe.offlineAgents,
    offlineAgentIds: probe.offlineAgentIds,
  }
}

// ─── Banner mapping ─────────────────────────────────────────────────

export interface ConnectionBanner {
  readonly severity: 'warning' | 'danger'
  /** English default message (already interpolated). */
  readonly message: string
  /** i18n key for the message; localized templates live in `src/i18n/*.json`. */
  readonly i18nKey: string
  /** Interpolation params for the i18n template. */
  readonly i18nParams?: Readonly<Record<string, string | number>>
  readonly showSpinner: boolean
  /** Optional operator action the banner should offer. */
  readonly action?: 'sign-in'
}

export function describeConnectionHealth(health: ConnectionHealth): ConnectionBanner | null {
  switch (health.kind) {
    case 'connected':
      return null
    case 'reconnecting':
      return {
        severity: 'warning',
        message: i18n.t('connection.reconnecting'),
        i18nKey: 'connection.reconnecting',
        showSpinner: true,
      }
    case 'cluster-degraded': {
      const ids = health.offlineAgentIds ?? []
      if (ids.length > 0) {
        return {
          severity: 'warning',
          message: i18n.t('connection.degradedNodes', { nodes: ids.join(', '), count: ids.length }),
          i18nKey: 'connection.degradedNodes',
          i18nParams: { nodes: ids.join(', '), count: ids.length },
          showSpinner: true,
        }
      }
      if (health.offlineAgents !== null && health.offlineAgents > 0) {
        return {
          severity: 'warning',
          message: i18n.t('connection.degradedCount', { count: health.offlineAgents }),
          i18nKey: 'connection.degradedCount',
          i18nParams: { count: health.offlineAgents },
          showSpinner: true,
        }
      }
      return {
        severity: 'warning',
        message: i18n.t('connection.degraded'),
        i18nKey: 'connection.degraded',
        showSpinner: true,
      }
    }
    case 'hub-unreachable':
      return {
        severity: 'danger',
        message: i18n.t('connection.disconnected'),
        i18nKey: 'connection.disconnected',
        showSpinner: true,
      }
    case 'auth-expired':
      return {
        severity: 'danger',
        message: i18n.t('connection.sessionExpired'),
        i18nKey: 'connection.sessionExpired',
        showSpinner: false,
        action: 'sign-in',
      }
  }
}

// ─── Hub-only probe ─────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 4_000
const PROBE_INTERVAL_MS = 5_000

export interface ProbeHubOptions {
  /** Server base, e.g. `hubOrigin()` — origin plus the page's mount. */
  readonly origin: string
  /** Returns the current session token (or null when logged out). */
  readonly getToken: () => string | null
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch
  /** Per-request cutoff. Default 4s. */
  readonly timeoutMs?: number
}

interface HealthBodyAgents {
  readonly offline: number | null
  readonly offlineIds: readonly string[] | null
  readonly ok: boolean | null
}

/** Defensive parse of the `/health` JSON body — older hubs / proxies
 *  may return anything; absence of fields must never throw. */
function parseHealthBody(body: unknown): HealthBodyAgents {
  if (typeof body !== 'object' || body === null) {
    return { offline: null, offlineIds: null, ok: null }
  }
  const record: Record<string, unknown> = { ...body }
  const ok = typeof record['ok'] === 'boolean' ? record['ok'] : null
  const agents = record['agents']
  if (typeof agents !== 'object' || agents === null) {
    return { offline: null, offlineIds: null, ok }
  }
  const agentsRecord: Record<string, unknown> = { ...agents }
  const offlineRaw = agentsRecord['offline']
  const offline = typeof offlineRaw === 'number' ? offlineRaw : null
  const offlineIdsRaw = agentsRecord['offlineIds']
  const offlineIds = Array.isArray(offlineIdsRaw)
    ? offlineIdsRaw.filter((id): id is string => typeof id === 'string')
    : null
  return { offline, offlineIds, ok }
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
      ...(headers !== undefined ? { headers } : {}),
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe HUB liveness only — `GET /health` is served from the hub's
 * in-memory registry (no fan-out to agent nodes), so a frozen agent
 * cannot fail this probe. `GET /trpc/auth.me` then validates the
 * session over the tRPC HTTP fallback.
 */
export async function probeHub(options: ProbeHubOptions): Promise<HubProbeResult> {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const base = options.origin.replace(/\/+$/, '')

  let healthRes: Response
  try {
    healthRes = await fetchWithTimeout(fetchFn, `${base}/health`, timeoutMs)
  } catch {
    return { hubReachable: false, authOk: 'unknown', offlineAgents: null, offlineAgentIds: null }
  }

  // A reverse proxy (Cloudflare tunnel, nginx) answers 5xx with its own
  // body when the hub is down — only a 2xx counts as "the hub answered".
  // A 503 with `ok:false` IS the hub, but in degraded boot (tRPC layer
  // unregistered) — the app cannot work against it, so treat it as
  // unreachable rather than "degraded but fine".
  if (!healthRes.ok) {
    return { hubReachable: false, authOk: 'unknown', offlineAgents: null, offlineAgentIds: null }
  }
  // Agent topology moved behind the AUTHENTICATED /health/details (the
  // public /health is liveness-only now). Prefer it when a token exists;
  // fall back to whatever /health returned (older hubs still inline the
  // agent block there — parseHealthBody tolerates both shapes).
  let detailsBody: unknown = null
  const detailsToken = options.getToken()
  if (detailsToken !== null && detailsToken !== '') {
    try {
      const detailsRes = await fetchWithTimeout(fetchFn, `${base}/health/details`, timeoutMs, {
        Authorization: `Bearer ${detailsToken}`,
      })
      if (detailsRes.ok) detailsBody = await detailsRes.json()
    } catch {
      /* details unavailable — liveness alone still stands */
    }
  }
  let parsed: HealthBodyAgents
  try {
    parsed = parseHealthBody(detailsBody ?? (await healthRes.json()))
  } catch {
    // 2xx with a non-JSON body: still the hub (proxies don't 200 on
    // /health when the origin is down) — just no agent detail.
    parsed = { offline: null, offlineIds: null, ok: null }
  }
  if (parsed.ok === false) {
    return { hubReachable: false, authOk: 'unknown', offlineAgents: null, offlineAgentIds: null }
  }

  const token = options.getToken()
  let authOk: boolean | 'unknown' = 'unknown'
  if (token !== null && token !== '') {
    try {
      const authRes = await fetchWithTimeout(fetchFn, `${base}/trpc/auth.me`, timeoutMs, {
        Authorization: `Bearer ${token}`,
      })
      if (authRes.status === 401 || authRes.status === 403) authOk = false
      else if (authRes.ok) authOk = true
    } catch {
      authOk = 'unknown'
    }
  }

  return {
    hubReachable: true,
    authOk,
    offlineAgents: parsed.offline,
    offlineAgentIds: parsed.offlineIds,
  }
}

// ─── Store (state machine) ──────────────────────────────────────────

export interface ConnectionHealthStoreDeps {
  readonly probe: () => Promise<HubProbeResult>
  /** Re-probe cadence while the WS stays down. Default 5s. */
  readonly probeIntervalMs?: number
}

export interface ConnectionHealthStore {
  readonly getSnapshot: () => ConnectionHealth
  readonly subscribe: (cb: () => void) => () => void
  readonly onSdkConnectionState: (state: SdkConnectionState) => void
  readonly dispose: () => void
}

const CONNECTED: ConnectionHealth = { kind: 'connected' }
const RECONNECTING: ConnectionHealth = { kind: 'reconnecting' }

export function createConnectionHealthStore(
  deps: ConnectionHealthStoreDeps,
): ConnectionHealthStore {
  const probeIntervalMs = deps.probeIntervalMs ?? PROBE_INTERVAL_MS
  const listeners = new Set<() => void>()
  // Starts connected: the banner only renders inside the authed layout,
  // which mounts after the boot gate — by then the WS either opened
  // (connected) or emitted `disconnected` (probe running). Starting
  // disconnected would flash a false banner on every page load.
  let state: ConnectionHealth = CONNECTED
  // Bumped on every SDK transition; in-flight probes capture it and
  // discard their result when it moved (e.g. WS reconnected mid-probe).
  let generation = 0
  let probing = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function setState(next: ConnectionHealth): void {
    if (state === next) return
    state = next
    for (const l of listeners) l()
  }

  function stopProbing(): void {
    probing = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function runProbe(): void {
    const g = generation
    void deps.probe().then(
      (result) => {
        if (g !== generation || !probing) return
        setState(classifyProbe(result))
        timer = setTimeout(runProbe, probeIntervalMs)
      },
      () => {
        if (g !== generation || !probing) return
        // A throwing probe function means we could not even attempt the
        // HTTP round-trip — treat as unreachable and keep re-probing.
        setState({ kind: 'hub-unreachable' })
        timer = setTimeout(runProbe, probeIntervalMs)
      },
    )
  }

  function onSdkConnectionState(next: SdkConnectionState): void {
    generation += 1
    if (next === 'connected') {
      stopProbing()
      setState(CONNECTED)
      return
    }
    if (next === 'connecting') {
      // Manual reconnect (watchdog resume / explicit System.reconnect):
      // transient by construction — no probe needed; the WS either opens
      // (connected) or closes (disconnected → probe path).
      stopProbing()
      setState(RECONNECTING)
      return
    }
    // 'disconnected' — keep an already-probed verdict on repeated close
    // events (WS flapping) instead of regressing to "Reconnecting…",
    // and (re)start the probe loop.
    if (state.kind === 'connected' || state.kind === 'reconnecting') {
      setState(RECONNECTING)
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    probing = true
    runProbe()
  }

  return {
    getSnapshot: () => state,
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onSdkConnectionState,
    dispose: () => {
      generation += 1
      stopProbing()
      listeners.clear()
    },
  }
}

// ─── Default singleton (browser wiring) ─────────────────────────────

let defaultStore: ConnectionHealthStore | null = null

export function getConnectionHealthStore(): ConnectionHealthStore {
  if (defaultStore === null) {
    defaultStore = createConnectionHealthStore({
      probe: () =>
        probeHub({
          origin: hubOrigin(),
          getToken: () => localStorage.getItem('camstack_admin_token'),
        }),
    })
  }
  return defaultStore
}

/** SDK `onConnectionChange` sink — wired in `lib/backend.ts`. */
export function reportSdkConnectionState(state: SdkConnectionState): void {
  getConnectionHealthStore().onSdkConnectionState(state)
}
