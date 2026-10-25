/**
 * The agent auth gate decides on the route the router MATCHED, not the raw URL (D857): Fastify
 * percent-decodes the path before matching, so an encoded spelling of a protected path must be
 * refused exactly like the plain one.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { AgentPairing } from '@camstack/system'
import { isAgentPaired } from '../agent-pairing-store.js'
import { createAgentHttpServer } from '../agent-http.js'
import type { ServiceBroker } from 'moleculer'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { unlockSession, writePairedConfig } from './helpers/paired-agent.js'

const REMOTE = '192.168.10.50'

const broker = {
  nodeID: 'test-agent',
  call: async () => ({
    ok: true,
    nodeId: 'test-agent',
    addons: [],
    localIps: [],
  }),
  registry: { getNodeList: () => [] },
} as unknown as ServiceBroker

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanups) await c()
})

async function build() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-route-gate-'))
  fs.mkdirSync(path.join(tmp, 'agent-ui', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'agent-ui', 'index.html'), '<html>agent-ui</html>')
  fs.writeFileSync(path.join(tmp, 'agent-ui', 'assets', 'a.js'), 'export {}')
  const configPath = path.join(tmp, 'agent.json')
  const fixture = await writePairedConfig(configPath, 'test-agent', {})
  const app = await createAgentHttpServer(() => broker, {
    port: 0,
    nodeId: 'test-agent',
    dataDir: tmp,
    configPath,
    pairing: new AgentPairing({
      nodeId: 'test-agent',
      version: null,
      isPaired: () => isAgentPaired(configPath),
      install: async () => undefined,
    }),
  })
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { app, fixture }
}

const ENCODED: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/%61pi/agent/restart'],
  ['GET', '/%61pi/agent/config'],
  ['GET', '/api%2Fagent/config'],
  ['GET', '/API/agent/config'],
  ['GET', '//api/agent/config'],
  ['GET', '/health%2Fdetails'],
  ['GET', '/%68ealth/details'],
  ['POST', '/%61pi/agent/pairing/forget'],
  ['POST', '/%61pi/agent/server-update/apply'],
  ['POST', '/%61pi/agent/process/restart'],
]

describe('agent auth gate follows the matched route', () => {
  it('refuses every encoded or odd spelling of a protected path, remotely and unauthenticated', async () => {
    const { app } = await build()
    for (const [method, url] of ENCODED) {
      const res = await app.inject({
        method: method === 'POST' ? 'POST' : 'GET',
        url,
        remoteAddress: REMOTE,
        payload: method === 'POST' ? {} : undefined,
      })
      // Refused (401) or unmatched (404, or the SPA shell for a GET): never a handler's answer.
      if (res.statusCode === 200) {
        expect(res.body, `${method} ${url}`).toBe('<html>agent-ui</html>')
      } else {
        expect([401, 404], `${method} ${url}`).toContain(res.statusCode)
      }
    }
  })

  it('keeps the public routes and the UI bundle open', async () => {
    const { app } = await build()
    const health = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: REMOTE,
    })
    expect(health.statusCode).toBe(200)
    const info = await app.inject({
      method: 'GET',
      url: '/api/agent/unlock-info',
      remoteAddress: REMOTE,
    })
    expect(info.statusCode).not.toBe(401)
    const hello = await app.inject({
      method: 'GET',
      url: '/api/agent/pairing/hello',
      remoteAddress: REMOTE,
    })
    expect(hello.statusCode).not.toBe(401)
    const index = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: REMOTE,
    })
    expect(index.statusCode).toBe(200)
    expect(index.body).toContain('agent-ui')
    const asset = await app.inject({
      method: 'GET',
      url: '/assets/a.js',
      remoteAddress: REMOTE,
    })
    expect(asset.statusCode).toBe(200)
  })

  it('still lets an authenticated session through', async () => {
    const { app, fixture } = await build()
    const headers = await unlockSession(app, fixture.ca, 'test-agent')
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/config',
      remoteAddress: REMOTE,
      headers,
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/agent/config value types', () => {
  it('refuses wrong types, oversize strings and an unknown logLevel; accepts valid values', async () => {
    const { app } = await build()
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/agent/config',
        remoteAddress: '127.0.0.1',
        payload: payload as object,
      })
    expect((await post({ name: 42 })).statusCode).toBe(400)
    expect((await post({ hubAddress: { a: 1 } })).statusCode).toBe(400)
    expect((await post({ hubAddress: 'x'.repeat(5000) })).statusCode).toBe(400)
    expect((await post({ logLevel: 'verbose' })).statusCode).toBe(400)
    expect((await post({ name: 'ok', logLevel: 'warn' })).statusCode).toBe(200)
  })
})
