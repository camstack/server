/**
 * An `agent.json` that still holds the retired cluster `secret` (D857, step 2):
 * the field is inert. The agent boots, is paired by its certificate alone, never echoes
 * the field, never honours it as a credential on any route, and never rewrites the file
 * at boot (cleaning it is the operator's job, by hand).
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
const REMOTE = '192.168.10.50'
const STALE = 'a-secret-from-before-d857'
const LOCAL = { host: 'localhost:4444', 'content-type': 'application/json' }

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stale-secret-'))
  const configPath = path.join(dir, 'agent.json')
  await writePairedConfig(configPath, NODE, { secret: STALE, name: 'old agent' })
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

describe('agent.json with a stale `secret`', () => {
  it('boots paired by its certificate alone, and the secret is not echoed', async () => {
    const { app, configPath } = await boot()
    const before = fs.readFileSync(configPath, 'utf8')
    expect(isAgentPaired(configPath)).toBe(true)

    const status = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: '127.0.0.1',
    })
    expect(status.statusCode).toBe(200)
    const body: Record<string, unknown> = status.json()
    expect(body['paired']).toBe(true)
    expect(body).not.toHaveProperty('hasSecret')
    expect(status.body).not.toContain(STALE)

    const config = await app.inject({
      method: 'GET',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
    })
    expect(config.statusCode).toBe(200)
    expect(config.body).not.toContain(STALE)
    expect(config.json()).not.toHaveProperty('secret')

    // Reading it changed nothing: there is no purge at boot or on read.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('opens nothing on the network, whatever the way it is presented', async () => {
    const { app } = await boot()
    const attempts: Array<Record<string, string>> = [
      { authorization: `Bearer ${STALE}` },
      { authorization: `Basic ${Buffer.from(`admin:${STALE}`).toString('base64')}` },
      { 'x-cluster-secret': STALE },
      { 'x-camstack-secret': STALE },
    ]
    for (const url of ['/api/agent/status', '/api/agent/config', '/api/agent/processes']) {
      for (const headers of attempts) {
        const res = await app.inject({ method: 'GET', url, remoteAddress: REMOTE, headers })
        expect(res.statusCode, `${url} ${Object.keys(headers)[0]}`).toBe(401)
      }
    }
    const post = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: REMOTE,
      headers: { authorization: `Bearer ${STALE}` },
      payload: { secret: STALE, hubAddress: 'evil:4443' },
    })
    expect(post.statusCode).toBe(401)
  })

  it('a posted `secret` is refused, and the one already in the file is left alone', async () => {
    const { app, configPath } = await boot()
    const before = fs.readFileSync(configPath, 'utf8')
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      headers: LOCAL,
      payload: { name: 'renamed', secret: 'a-new-one' },
    })
    expect(res.statusCode).toBe(400)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      headers: LOCAL,
      payload: { name: 'renamed' },
    })
    expect(ok.statusCode).toBe(200)
    const file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(file['name']).toBe('renamed')
    expect(file['secret']).toBe(STALE)
  })
})
