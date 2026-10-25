/**
 * connection-health.spec — TDD for the accurate connection banner
 * state machine.
 *
 * Scenarios (proven live on the cluster):
 *   - WS closed by the tRPC keepalive pong timeout while the hub is
 *     merely SLOW (frozen agent node stalling cluster-wide fan-outs)
 *     → the hub-only HTTP probe succeeds → `cluster-degraded`, NOT
 *     "Server unreachable".
 *   - WS closed AND the hub-only probe fails → `hub-unreachable`.
 *   - Hub alive but the session token is rejected → `auth-expired`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyProbe,
  createConnectionHealthStore,
  describeConnectionHealth,
  probeHub,
  type ConnectionHealth,
  type HubProbeResult,
} from '../connection-health'

// ─── classifyProbe (pure) ───────────────────────────────────────────

describe('classifyProbe', () => {
  it('maps an unreachable hub to hub-unreachable', () => {
    const probe: HubProbeResult = {
      hubReachable: false,
      authOk: 'unknown',
      offlineAgents: null,
      offlineAgentIds: null,
    }
    expect(classifyProbe(probe)).toEqual({ kind: 'hub-unreachable' })
  })

  it('maps a reachable hub with rejected auth to auth-expired', () => {
    const probe: HubProbeResult = {
      hubReachable: true,
      authOk: false,
      offlineAgents: null,
      offlineAgentIds: null,
    }
    expect(classifyProbe(probe)).toEqual({ kind: 'auth-expired' })
  })

  it('maps a reachable hub with valid auth to cluster-degraded (WS down but hub alive)', () => {
    const probe: HubProbeResult = {
      hubReachable: true,
      authOk: true,
      offlineAgents: 1,
      offlineAgentIds: ['agent-a'],
    }
    expect(classifyProbe(probe)).toEqual({
      kind: 'cluster-degraded',
      offlineAgents: 1,
      offlineAgentIds: ['agent-a'],
    })
  })

  it('maps a reachable hub with unknown auth to cluster-degraded', () => {
    const probe: HubProbeResult = {
      hubReachable: true,
      authOk: 'unknown',
      offlineAgents: null,
      offlineAgentIds: null,
    }
    expect(classifyProbe(probe)).toEqual({
      kind: 'cluster-degraded',
      offlineAgents: null,
      offlineAgentIds: null,
    })
  })
})

// ─── probeHub (injected fetch) ──────────────────────────────────────

type FetchFn = typeof fetch

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const HEALTHY_BODY = {
  ok: true,
  nodeId: 'hub',
  agents: { total: 2, online: 2, offline: 0 },
}

describe('probeHub', () => {
  it('reports hubReachable + authOk when /health 200 ok:true and auth.me 200', async () => {
    const calls: string[] = []
    const fetchFn: FetchFn = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/health')) return jsonResponse(200, HEALTHY_BODY)
      return jsonResponse(200, { result: { data: {} } })
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'tok',
      fetchFn,
    })
    expect(result.hubReachable).toBe(true)
    expect(result.authOk).toBe(true)
    // With a token on board the probe is a 3-leg sequence: public
    // liveness → authed agent topology → authed session check.
    expect(calls[0]).toBe('https://hub.example/health')
    expect(calls[1]).toBe('https://hub.example/health/details')
    expect(calls[2]).toBe('https://hub.example/trpc/auth.me')
  })

  it('reports hub unreachable when /health rejects (network error) and skips the auth probe', async () => {
    const calls: string[] = []
    const fetchFn: FetchFn = async (input) => {
      calls.push(String(input))
      throw new TypeError('fetch failed')
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'tok',
      fetchFn,
    })
    expect(result.hubReachable).toBe(false)
    expect(result.authOk).toBe('unknown')
    expect(calls).toHaveLength(1)
  })

  it('treats a reverse-proxy 502 as hub unreachable (response body is not hub health)', async () => {
    const fetchFn: FetchFn = async () => new Response('<html>bad gateway</html>', { status: 502 })
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => null,
      fetchFn,
    })
    expect(result.hubReachable).toBe(false)
  })

  it('treats a degraded-boot /health 503 ok:false as hub unreachable (API layer down)', async () => {
    const fetchFn: FetchFn = async () => jsonResponse(503, { ...HEALTHY_BODY, ok: false })
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => null,
      fetchFn,
    })
    expect(result.hubReachable).toBe(false)
  })

  it('reports authOk=false when auth.me returns 401', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(200, HEALTHY_BODY)
      return jsonResponse(401, { error: { code: 'UNAUTHORIZED' } })
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'expired',
      fetchFn,
    })
    expect(result.hubReachable).toBe(true)
    expect(result.authOk).toBe(false)
  })

  it('reports authOk=unknown and does not probe auth when no token is present', async () => {
    const calls: string[] = []
    const fetchFn: FetchFn = async (input) => {
      calls.push(String(input))
      return jsonResponse(200, HEALTHY_BODY)
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => null,
      fetchFn,
    })
    expect(result.authOk).toBe('unknown')
    expect(calls).toHaveLength(1)
  })

  it('surfaces offline agent counts and ids from the authed /health/details body', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input)
      // Public /health is liveness-only now — agent topology lives
      // behind the authenticated /health/details.
      if (url.endsWith('/health')) return jsonResponse(200, { ok: true, nodeId: 'hub' })
      if (url.endsWith('/health/details')) {
        return jsonResponse(200, {
          ok: true,
          nodeId: 'hub',
          agents: { total: 3, online: 2, offline: 1, offlineIds: ['agent-a'] },
        })
      }
      return jsonResponse(200, {})
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'tok',
      fetchFn,
    })
    expect(result.offlineAgents).toBe(1)
    expect(result.offlineAgentIds).toEqual(['agent-a'])
  })

  it('falls back to agent topology inlined in /health (older hub) when details is unavailable', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return jsonResponse(200, {
          ok: true,
          nodeId: 'hub',
          agents: { total: 3, online: 2, offline: 1, offlineIds: ['agent-a'] },
        })
      }
      if (url.endsWith('/health/details')) return jsonResponse(404, { error: 'not found' })
      return jsonResponse(200, {})
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'tok',
      fetchFn,
    })
    expect(result.offlineAgents).toBe(1)
    expect(result.offlineAgentIds).toEqual(['agent-a'])
  })

  it('tolerates an unparseable /health body (older hub) without crashing', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return jsonResponse(200, {})
    }
    const result = await probeHub({
      origin: 'https://hub.example',
      getToken: () => 'tok',
      fetchFn,
    })
    // A 200 without a parseable hub body is still counted as reachable —
    // a reverse proxy would not answer 200 on /health when the hub is down.
    expect(result.hubReachable).toBe(true)
    expect(result.offlineAgents).toBeNull()
    expect(result.offlineAgentIds).toBeNull()
  })
})

// ─── store state machine (fake timers + injected probe) ─────────────

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const PROBE_OK: HubProbeResult = {
  hubReachable: true,
  authOk: true,
  offlineAgents: 0,
  offlineAgentIds: [],
}
const PROBE_FAIL: HubProbeResult = {
  hubReachable: false,
  authOk: 'unknown',
  offlineAgents: null,
  offlineAgentIds: null,
}
const PROBE_AUTH_EXPIRED: HubProbeResult = {
  hubReachable: true,
  authOk: false,
  offlineAgents: null,
  offlineAgentIds: null,
}

describe('createConnectionHealthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function flush(): Promise<void> {
    // Let pending microtasks (probe promise chains) settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('starts connected and stays connected on sdk connected events', () => {
    const store = createConnectionHealthStore({ probe: async () => PROBE_OK })
    expect(store.getSnapshot()).toEqual({ kind: 'connected' })
    store.onSdkConnectionState('connected')
    expect(store.getSnapshot()).toEqual({ kind: 'connected' })
    store.dispose()
  })

  it('shows reconnecting immediately on disconnect, then cluster-degraded when the hub probe succeeds', async () => {
    const store = createConnectionHealthStore({ probe: async () => PROBE_OK })
    store.onSdkConnectionState('disconnected')
    expect(store.getSnapshot()).toEqual({ kind: 'reconnecting' })
    await flush()
    expect(store.getSnapshot()).toEqual({
      kind: 'cluster-degraded',
      offlineAgents: 0,
      offlineAgentIds: [],
    })
    store.dispose()
  })

  it('shows hub-unreachable when the hub probe fails, and recovers to cluster-degraded on a later successful probe', async () => {
    let result: HubProbeResult = PROBE_FAIL
    const store = createConnectionHealthStore({
      probe: async () => result,
      probeIntervalMs: 5_000,
    })
    store.onSdkConnectionState('disconnected')
    await flush()
    expect(store.getSnapshot()).toEqual({ kind: 'hub-unreachable' })

    result = PROBE_OK
    vi.advanceTimersByTime(5_000)
    await flush()
    expect(store.getSnapshot()).toEqual({
      kind: 'cluster-degraded',
      offlineAgents: 0,
      offlineAgentIds: [],
    })
    store.dispose()
  })

  it('shows auth-expired when the hub is alive but the token is rejected', async () => {
    const store = createConnectionHealthStore({ probe: async () => PROBE_AUTH_EXPIRED })
    store.onSdkConnectionState('disconnected')
    await flush()
    expect(store.getSnapshot()).toEqual({ kind: 'auth-expired' })
    store.dispose()
  })

  it('returns to connected on sdk connected and stops probing', async () => {
    let probes = 0
    const store = createConnectionHealthStore({
      probe: async () => {
        probes += 1
        return PROBE_OK
      },
      probeIntervalMs: 5_000,
    })
    store.onSdkConnectionState('disconnected')
    await flush()
    store.onSdkConnectionState('connected')
    expect(store.getSnapshot()).toEqual({ kind: 'connected' })
    const probesAtReconnect = probes
    vi.advanceTimersByTime(60_000)
    await flush()
    expect(probes).toBe(probesAtReconnect)
    expect(store.getSnapshot()).toEqual({ kind: 'connected' })
    store.dispose()
  })

  it('discards a stale probe result that resolves after the sdk reconnected', async () => {
    const gate = deferred<HubProbeResult>()
    const store = createConnectionHealthStore({ probe: () => gate.promise })
    store.onSdkConnectionState('disconnected')
    store.onSdkConnectionState('connected')
    gate.resolve(PROBE_FAIL)
    await flush()
    expect(store.getSnapshot()).toEqual({ kind: 'connected' })
    store.dispose()
  })

  it('does not regress a probed state back to reconnecting on repeated disconnect events (WS flapping)', async () => {
    const store = createConnectionHealthStore({
      probe: async () => PROBE_OK,
      probeIntervalMs: 5_000,
    })
    store.onSdkConnectionState('disconnected')
    await flush()
    expect(store.getSnapshot().kind).toBe('cluster-degraded')
    store.onSdkConnectionState('disconnected')
    expect(store.getSnapshot().kind).toBe('cluster-degraded')
    store.dispose()
  })

  it('maps a manual reconnect (connecting) to reconnecting', () => {
    const store = createConnectionHealthStore({ probe: async () => PROBE_OK })
    store.onSdkConnectionState('connecting')
    expect(store.getSnapshot()).toEqual({ kind: 'reconnecting' })
    store.dispose()
  })

  it('notifies subscribers on every state change', async () => {
    const store = createConnectionHealthStore({ probe: async () => PROBE_OK })
    const seen: ConnectionHealth[] = []
    const unsub = store.subscribe(() => {
      seen.push(store.getSnapshot())
    })
    store.onSdkConnectionState('disconnected')
    await flush()
    expect(seen.map((s) => s.kind)).toEqual(['reconnecting', 'cluster-degraded'])
    unsub()
    store.dispose()
  })
})

// ─── describeConnectionHealth (banner mapping) ──────────────────────

describe('describeConnectionHealth', () => {
  it('returns null when connected (no banner)', () => {
    expect(describeConnectionHealth({ kind: 'connected' })).toBeNull()
  })

  it('maps reconnecting to a non-alarming warning banner', () => {
    const banner = describeConnectionHealth({ kind: 'reconnecting' })
    expect(banner).not.toBeNull()
    expect(banner?.severity).toBe('warning')
    expect(banner?.showSpinner).toBe(true)
  })

  it('names the unresponsive node in the cluster-degraded banner', () => {
    const banner = describeConnectionHealth({
      kind: 'cluster-degraded',
      offlineAgents: 1,
      offlineAgentIds: ['agent-a'],
    })
    expect(banner?.severity).toBe('warning')
    expect(banner?.message).toContain('agent-a')
    expect(banner?.message).not.toContain('unreachable')
    expect(banner?.i18nKey).toBe('connection.degradedNodes')
    expect(banner?.i18nParams).toEqual({ nodes: 'agent-a', count: 1 })
  })

  it('falls back to an offline count when node ids are unavailable', () => {
    const banner = describeConnectionHealth({
      kind: 'cluster-degraded',
      offlineAgents: 2,
      offlineAgentIds: null,
    })
    expect(banner?.message).toContain('2')
  })

  it('states the hub is online when no node info is available', () => {
    const banner = describeConnectionHealth({
      kind: 'cluster-degraded',
      offlineAgents: null,
      offlineAgentIds: null,
    })
    expect(banner?.severity).toBe('warning')
    expect(banner?.message.toLowerCase()).toContain('hub is online')
  })

  it('reserves the alarming Server-unreachable banner for a failed hub probe', () => {
    const banner = describeConnectionHealth({ kind: 'hub-unreachable' })
    expect(banner?.severity).toBe('danger')
    expect(banner?.message).toContain('Server unreachable')
    expect(banner?.i18nKey).toBe('connection.disconnected')
  })

  it('maps auth-expired to a sign-in action', () => {
    const banner = describeConnectionHealth({ kind: 'auth-expired' })
    expect(banner?.severity).toBe('danger')
    expect(banner?.message).toContain('Session expired')
    expect(banner?.action).toBe('sign-in')
  })
})
