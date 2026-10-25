/**
 * Agent HTTP hardening (port 4444) — end-to-end via `fastify.inject` (D857):
 *   - `/health` is PUBLIC liveness-only (`{ok}` — no nodeId/topology),
 *   - `/health/details` + every `/api/agent/*` route require loopback or a session
 *     redeemed from a hub unlock ticket signed by the mesh CA this agent pinned,
 *   - an UNPAIRED agent exposes only the pairing protocol remotely,
 *   - the retired cluster secret (an old `secret` field in agent.json) opens nothing,
 *   - loopback callers (the agent's own page) are never challenged.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { AgentPairing, generateMeshCa, mintAgentUiUnlockTicket } from '@camstack/system'
import { isAgentPaired } from '../agent-pairing-store.js'
import { createAgentHttpServer } from '../agent-http.js'
import type { AgentHttpConfig } from '../agent-http.js'
import type { ServiceBroker } from 'moleculer'
import type { FastifyInstance } from 'fastify'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { unlockSession, writePairedConfig, type PairedFixture } from './helpers/paired-agent.js'

const REMOTE = '192.168.10.50'
const OLD_SECRET = 'a-retired-cluster-secret'

function makeStubBroker(): ServiceBroker {
  return {
    nodeID: 'test-agent',
    call: async (action: string) => {
      if (action === '$agent.health') {
        return { ok: true, nodeId: 'test-agent', version: '9.9.9' }
      }
      return { nodeId: 'test-agent', addons: [], localIps: [] }
    },
    registry: {
      getNodeList: (_opts: { onlyAvailable: boolean }) => [],
    },
  } as unknown as ServiceBroker
}

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanups) await c()
})

async function buildApp(
  options: { paired: boolean } = { paired: false },
): Promise<{ app: FastifyInstance; fixture: PairedFixture | null }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-hardening-'))
  const configPath = path.join(tmpDir, 'agent.json')
  const fixture = options.paired
    ? await writePairedConfig(configPath, 'test-agent', { secret: OLD_SECRET })
    : null
  const config: AgentHttpConfig = {
    port: 0,
    nodeId: 'test-agent',
    dataDir: tmpDir,
    configPath,
    pairing: new AgentPairing({
      nodeId: 'test-agent',
      version: null,
      isPaired: () => isAgentPaired(configPath),
      install: async () => undefined,
    }),
  }
  const app = await createAgentHttpServer(() => makeStubBroker(), config)
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { app, fixture }
}

describe('agent /health hardening', () => {
  it('public /health is liveness-only — no nodeId, no version', async () => {
    const { app } = await buildApp({ paired: true })
    const res = await app.inject({ method: 'GET', url: '/health', remoteAddress: REMOTE })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('/health/details requires a hub-unlocked session remotely and returns the detailed payload', async () => {
    const { app, fixture } = await buildApp({ paired: true })
    const unauth = await app.inject({
      method: 'GET',
      url: '/health/details',
      remoteAddress: REMOTE,
    })
    expect(unauth.statusCode).toBe(401)
    if (fixture === null) throw new Error('paired fixture missing')
    const headers = await unlockSession(app, fixture.ca, 'test-agent')
    const authed = await app.inject({
      method: 'GET',
      url: '/health/details',
      remoteAddress: REMOTE,
      headers,
    })
    expect(authed.statusCode).toBe(200)
    expect(authed.json()).toMatchObject({ ok: true, nodeId: 'test-agent' })
  })
})

describe('agent /api hardening (paired)', () => {
  it('rejects remote unauthenticated API calls', async () => {
    const { app } = await buildApp({ paired: true })
    for (const url of ['/api/agent/status', '/api/agent/config', '/api/agent/processes']) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: REMOTE })
      expect(res.statusCode, url).toBe(401)
    }
    const post = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: REMOTE,
      payload: { hubAddress: 'evil:4443' },
    })
    expect(post.statusCode).toBe(401)
  })

  it('the retired cluster secret opens nothing, as a Bearer or otherwise', async () => {
    const { app } = await buildApp({ paired: true })
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: REMOTE,
      headers: { authorization: `Bearer ${OLD_SECRET}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts remote calls with a session redeemed from a ticket the pinned CA signed', async () => {
    const { app, fixture } = await buildApp({ paired: true })
    if (fixture === null) throw new Error('paired fixture missing')
    const headers = await unlockSession(app, fixture.ca, 'test-agent')
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: REMOTE,
      headers,
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a ticket signed by another CA, one for another node and a replayed one', async () => {
    const { app, fixture } = await buildApp({ paired: true })
    if (fixture === null) throw new Error('paired fixture missing')
    const redeem = (ticket: string) =>
      app.inject({
        method: 'POST',
        url: '/api/agent/session',
        remoteAddress: REMOTE,
        payload: { ticket },
      })
    const stranger = await generateMeshCa()
    expect(
      (await redeem(mintAgentUiUnlockTicket({ caKeyPem: stranger.keyPem, nodeId: 'test-agent' })))
        .statusCode,
    ).toBe(401)
    expect(
      (await redeem(mintAgentUiUnlockTicket({ caKeyPem: fixture.ca.keyPem, nodeId: 'another' })))
        .statusCode,
    ).toBe(401)
    const once = mintAgentUiUnlockTicket({ caKeyPem: fixture.ca.keyPem, nodeId: 'test-agent' })
    expect((await redeem(once)).statusCode).toBe(200)
    expect((await redeem(once)).statusCode).toBe(401)
  })

  it('never challenges loopback callers', async () => {
    const { app } = await buildApp({ paired: true })
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('agent /api hardening (unpaired)', () => {
  it('exposes the pairing protocol remotely, and nothing else', async () => {
    const { app } = await buildApp({ paired: false })
    const hello = await app.inject({
      method: 'GET',
      url: '/api/agent/pairing/hello',
      remoteAddress: REMOTE,
    })
    expect(hello.statusCode).toBe(200)
    for (const [method, url] of [
      ['GET', '/api/agent/status'],
      ['GET', '/api/agent/config'],
      ['GET', '/api/agent/processes'],
      ['GET', '/api/agent/hubs-found'],
      ['POST', '/api/agent/config'],
      ['POST', '/api/agent/restart'],
      ['POST', '/api/agent/pairing/forget'],
    ] as const) {
      const res = await app.inject({ method, url, remoteAddress: REMOTE, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it('refuses to redeem an unlock ticket: there is no CA to verify it against', async () => {
    const { app } = await buildApp({ paired: false })
    const ca = await generateMeshCa()
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/session',
      remoteAddress: REMOTE,
      payload: { ticket: mintAgentUiUnlockTicket({ caKeyPem: ca.keyPem, nodeId: 'test-agent' }) },
    })
    expect(res.statusCode).toBe(400)
  })
})
