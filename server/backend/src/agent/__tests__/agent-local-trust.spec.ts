/**
 * What "this machine" means on the agent's :4444 (D857). A loopback peer is trusted only when
 * the request cannot have been made by a web page: a local Host (DNS rebinding), no foreign
 * Origin (cross-site fetch), a JSON content type on a mutation (a form post), and the API
 * sends no CORS headers. The config API writes only name / hubAddress / logLevel and never
 * reveals the machine's paths.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { ServiceBroker } from 'moleculer'
import { AgentPairing } from '@camstack/system'
import { afterAll, describe, expect, it } from 'vitest'
import { createAgentHttpServer } from '../agent-http.js'
import { isAgentPaired } from '../agent-pairing-store.js'
import { writePairedConfig } from './helpers/paired-agent.js'

const NODE = 'test-agent'
const JSON_HEADERS = { 'content-type': 'application/json' }

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanups) await c()
})

function stubBroker(): ServiceBroker {
  return {
    nodeID: NODE,
    call: async () => ({ nodeId: NODE, addons: [], localIps: [] }),
    registry: { getNodeList: () => [] },
  } as unknown as ServiceBroker
}

async function boot(): Promise<{ app: FastifyInstance; configPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-local-trust-'))
  const configPath = path.join(dir, 'agent.json')
  await writePairedConfig(configPath, NODE, { name: 'kitchen' })
  const app = await createAgentHttpServer(() => stubBroker(), {
    port: 0,
    nodeId: NODE,
    dataDir: dir,
    configPath,
    pairing: new AgentPairing({
      nodeId: NODE,
      version: null,
      isPaired: () => isAgentPaired(configPath),
      install: async () => undefined,
    }),
  })
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { app, configPath }
}

const get = (app: FastifyInstance, headers: Record<string, string>, url = '/api/agent/status') =>
  app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers })

describe('loopback is trusted only when no web page can have made the request', () => {
  it('serves the agent page itself: local Host, no or same-origin Origin', async () => {
    const { app } = await boot()
    const cases: Array<Record<string, string>> = [
      { host: 'localhost:4444' },
      { host: '127.0.0.1:4444' },
      { host: '[::1]:4444' },
      { host: '127.0.0.1:4444', origin: 'http://127.0.0.1:4444' },
    ]
    for (const headers of cases) {
      expect((await get(app, headers)).statusCode, JSON.stringify(headers)).toBe(200)
    }
  })

  it('refuses a rebound hostname: a loopback socket with a foreign Host', async () => {
    const { app } = await boot()
    for (const host of [
      'evil.example',
      'evil.example:4444',
      '192.168.1.5:4444',
      'localhost.evil.example',
    ]) {
      expect((await get(app, { host })).statusCode, host).toBe(401)
    }
  })

  it('refuses a cross-site request: a foreign or opaque Origin', async () => {
    const { app } = await boot()
    for (const origin of ['http://evil.example', 'null', 'http://localhost:9999']) {
      const res = await get(app, { host: 'localhost:4444', origin })
      expect(res.statusCode, origin).toBe(401)
    }
  })

  it('requires application/json on a mutation, so a form post is not "this machine"', async () => {
    const { app } = await boot()
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/config',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:4444',
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        payload: contentType ? '{"name":"x"}' : undefined,
      })
      expect(res.statusCode, String(contentType)).toBe(401)
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:4444', ...JSON_HEADERS },
      payload: { name: 'x' },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('sends no CORS headers, not even to a preflight', async () => {
    const { app } = await boot()
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/agent/config',
      remoteAddress: '192.0.2.20',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        host: 'agent.lan:4444',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    const page = await get(app, { host: 'localhost:4444', origin: 'http://localhost:4444' })
    expect(page.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('a rebound page is not local for pairing either: it has to present the PIN', async () => {
    const { app } = await boot()
    const status = await get(app, { host: 'evil.example' }, '/api/agent/pairing/status')
    expect(JSON.stringify(status.json())).not.toMatch(/pin|pairingId/i)
    const reject = await app.inject({
      method: 'POST',
      url: '/api/agent/pairing/reject',
      remoteAddress: '127.0.0.1',
      headers: { host: 'evil.example', ...JSON_HEADERS },
      payload: {},
    })
    expect(reject.statusCode).not.toBe(200)
  })
})

describe('the config API', () => {
  const LOCAL = { host: 'localhost:4444', ...JSON_HEADERS }

  it('writes name, hubAddress and logLevel only, and nothing else at all', async () => {
    const { app, configPath } = await boot()
    const before = fs.readFileSync(configPath, 'utf8')
    for (const key of [
      'meshTls',
      'meshTlsPrevious',
      'meshSwap',
      'nodeId',
      'joinToken',
      'secret',
      'clearMeshTls',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/config',
        remoteAddress: '127.0.0.1',
        headers: LOCAL,
        payload: { name: 'ok', [key]: 'x' },
      })
      expect(res.statusCode, key).toBe(400)
      expect(fs.readFileSync(configPath, 'utf8'), key).toBe(before)
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      headers: LOCAL,
      payload: { name: 'bedroom', hubAddress: '10.0.0.2', logLevel: 'debug' },
    })
    expect(ok.statusCode).toBe(200)
    const file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(file).toMatchObject({ name: 'bedroom', hubAddress: '10.0.0.2', logLevel: 'debug' })
  })

  it('does not reveal where the agent keeps its files', async () => {
    const { app, configPath } = await boot()
    const res = await get(app, { host: 'localhost:4444' }, '/api/agent/config')
    expect(res.statusCode).toBe(200)
    const body: Record<string, unknown> = res.json()
    expect(body).not.toHaveProperty('configPath')
    expect(body).not.toHaveProperty('dataDir')
    expect(res.body).not.toContain(path.dirname(configPath))
    expect(res.body).not.toContain('PRIVATE KEY')
  })
})
