/**
 * Health routes end-to-end (fastify.inject) — proves the #26 fix: `/health`
 * and `/health/agents` are served purely from the in-memory node registry
 * and NEVER call the broker, so a frozen agent cannot slow them or flip the
 * admin-ui banner to a false RED "Server unreachable". `/health/cluster`
 * still fans `$agent.health` out to ONLINE nodes only.
 *
 * Post-hardening contract (4a7d52bc): the PUBLIC `/health` is liveness-only
 * (`{ok}` — no version, no topology); agent topology moved behind the
 * AUTHENTICATED `/health/details`, and `/health/agents` + `/health/cluster`
 * require a session-grade credential too.
 */

import type { NodeLiveness } from '@camstack/types'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  type HealthAgentRegistry,
  type HealthBrokerCaller,
  registerHealthRoutes,
} from '../api/health/health.routes'
import { toNodeLiveness } from '../core/agent/agent-registry.service'

const NODES: readonly NodeLiveness[] = [
  { id: 'hub', isHub: true, isOnline: true },
  { id: 'big-unraid', isHub: false, isOnline: true },
  { id: 'agent-a', isHub: false, isOnline: false },
]

/** Only this bearer verifies to a session-grade payload (userId + isAdmin, no kind tag). */
const SESSION_TOKEN = 'session-tok'
const AUTH = { authorization: `Bearer ${SESSION_TOKEN}` }

function buildApp(brokerCall: HealthBrokerCaller['broker']['call']) {
  const agentRegistry: HealthAgentRegistry = { listNodeLiveness: () => NODES }
  const moleculer: HealthBrokerCaller = { broker: { call: brokerCall } }
  const app = Fastify()
  registerHealthRoutes(app, {
    moleculer,
    agentRegistry,
    hubVersion: '0.0.0-test',
    isReady: () => true,
    verifyToken: (token: string) => {
      if (token !== SESSION_TOKEN) throw new Error('invalid token')
      return { userId: 'u-1', isAdmin: true }
    },
  })
  return app
}

describe('health routes — frozen node cannot slow the hub-liveness probe (#26)', () => {
  it('GET /health is public liveness-only and never calls the broker', async () => {
    const call = vi.fn(async () => {
      throw new Error('/health must never fan out to the broker')
    })
    const app = buildApp(call)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    // Liveness only — no version / topology leak on the public probe.
    expect(res.json()).toEqual({ ok: true })
    expect(call).not.toHaveBeenCalled()
    await app.close()
  })

  it('GET /health/details requires auth, names the frozen node, never calls the broker', async () => {
    const call = vi.fn(async () => {
      throw new Error('/health/details must never fan out to the broker')
    })
    const app = buildApp(call)
    const unauth = await app.inject({ method: 'GET', url: '/health/details' })
    expect(unauth.statusCode).toBe(401)
    const res = await app.inject({ method: 'GET', url: '/health/details', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().agents).toEqual({
      total: 2,
      online: 1,
      offline: 1,
      offlineIds: ['agent-a'],
    })
    expect(call).not.toHaveBeenCalled()
    await app.close()
  })

  it('GET /health/agents requires auth, lists only online agents, no broker call', async () => {
    const call = vi.fn(async () => {
      throw new Error('/health/agents must never fan out to the broker')
    })
    const app = buildApp(call)
    const unauth = await app.inject({ method: 'GET', url: '/health/agents' })
    expect(unauth.statusCode).toBe(401)
    const res = await app.inject({ method: 'GET', url: '/health/agents', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agents: ['big-unraid'] })
    expect(call).not.toHaveBeenCalled()
    await app.close()
  })

  it('GET /health/cluster requires auth and fans $agent.health out to ONLINE nodes only', async () => {
    const call = vi.fn(async (_action, _params, opts: { nodeID: string }) => ({
      ok: true,
      nodeId: opts.nodeID,
    }))
    const app = buildApp(call)
    const unauth = await app.inject({ method: 'GET', url: '/health/cluster' })
    expect(unauth.statusCode).toBe(401)
    expect(call).not.toHaveBeenCalled()
    const res = await app.inject({ method: 'GET', url: '/health/cluster', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      '$agent.health',
      {},
      expect.objectContaining({ nodeID: 'big-unraid' }),
    )
    // never the frozen node
    for (const invocation of call.mock.calls) {
      expect(invocation[2]).not.toMatchObject({ nodeID: 'agent-a' })
    }
    await app.close()
  })
})

describe('toNodeLiveness', () => {
  it('maps available → isOnline and id==="hub" → isHub', () => {
    expect(
      toNodeLiveness([
        { id: 'hub', available: true },
        { id: 'agent-a', available: false },
      ]),
    ).toEqual([
      { id: 'hub', isHub: true, isOnline: true },
      { id: 'agent-a', isHub: false, isOnline: false },
    ])
  })

  it('filters child runner ids containing "/"', () => {
    expect(
      toNodeLiveness([
        { id: 'hub', available: true },
        { id: 'hub/detection-pipeline', available: true },
        { id: 'agent-a/decoder', available: true },
      ]),
    ).toEqual([{ id: 'hub', isHub: true, isOnline: true }])
  })

  it('returns an empty array for empty input', () => {
    expect(toNodeLiveness([])).toEqual([])
  })
})
