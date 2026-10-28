/**
 * Pairing over real HTTP (D857): the hub's HTTP client (`createHttpAgentPairingTransport`)
 * talks to the agent's real Fastify routes on a loopback socket, with the real
 * `AgentPairing` and the real `agent.json` writer behind them.
 *
 * What it adds to the in-memory specs in `@camstack/system`: the status codes and bodies the
 * hub parses, the network-reachable surface (a confirm or a completion needs nothing but the
 * pairing id), what lands in `agent.json` and what is erased by "forget".
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddressInfo } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ServiceBroker } from 'moleculer'
import {
  AgentPairing,
  generateMeshCa,
  HubPairing,
  type LocalPairingSecret,
  type MeshCaSigner,
  PairingHttpError,
} from '@camstack/system'
import { createHttpAgentPairingTransport } from '../../core/agent/agent-pairing-http.js'
import { createAgentHttpServer } from '../agent-http.js'
import { forgetPairing, isAgentPaired, persistPairing } from '../agent-pairing-store.js'

const NODE_ID = 'agent-a'

function stubBroker(): ServiceBroker {
  return {
    nodeID: NODE_ID,
    call: async () => ({ nodeId: NODE_ID, addons: [], localIps: [] }),
    registry: { getNodeList: () => [] },
  } as unknown as ServiceBroker
}

interface Rig {
  readonly dir: string
  readonly configPath: string
  readonly app: FastifyInstance
  readonly port: number
  readonly ca: MeshCaSigner
  readonly hub: HubPairing
  readonly forgotten: string[]
  post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  /** What this machine's console would have shown. */
  readonly local: Map<string, LocalPairingSecret>
  readonly resetCodes: string[]
}

let rig: Rig | null = null

async function start(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pairing-routes-'))
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({ nodeId: NODE_ID, name: 'Unraid', secret: 'retired' }),
  )
  const forgotten: string[] = []
  const local = new Map<string, LocalPairingSecret>()
  const resetCodes: string[] = []
  const pairing = new AgentPairing({
    nodeId: NODE_ID,
    version: '1.0.0',
    isPaired: () => isAgentPaired(configPath),
    install: async (installed) => persistPairing(configPath, installed),
    onLocalSecret: (secret) => local.set(secret.pairingId, secret),
    onLocalSecretCleared: (id) => local.delete(id),
    onResetCode: (code) => resetCodes.push(code),
  })
  const app = await createAgentHttpServer(() => stubBroker(), {
    port: 0,
    nodeId: NODE_ID,
    dataDir: dir,
    configPath,
    pairing,
    onForgetHub: async () => {
      forgotten.push('forgotten')
      forgetPairing(configPath, dir)
      pairing.noteUnpaired()
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = (address as AddressInfo).port
  const ca = await generateMeshCa()
  const hub = new HubPairing({
    transport: createHttpAgentPairingTransport(),
    ca: () => ca,
    hubNodeId: 'hub',
    hubUrl: async () => 'https://hub.example.test:4443',
    hubMeshAddress: async () => 'hub.example.test:6443',
    isNodeConnected: () => false,
    recordIssued: async () => undefined,
    revokeNode: async () => undefined,
  })
  return {
    dir,
    configPath,
    app,
    port,
    ca,
    hub,
    forgotten,
    local,
    resetCodes,
    post: async (url, body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    },
  }
}

beforeEach(async () => {
  rig = await start()
})

afterEach(async () => {
  if (rig !== null) {
    await rig.app.close()
    fs.rmSync(rig.dir, { recursive: true, force: true })
    rig = null
  }
})

function current(): Rig {
  if (rig === null) throw new Error('rig not started')
  return rig
}

const read = (configPath: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>

const REMOTE_HEADERS = { 'x-forwarded-for': '192.0.2.20' }

function theSecret(r: Rig): LocalPairingSecret {
  const [only] = [...r.local.values()]
  if (only === undefined) throw new Error('no local secret')
  return only
}

describe('pairing over the agent HTTP routes', () => {
  it('pairs end to end: both operators confirm, the certificate lands in agent.json', async () => {
    const r = current()
    const started = await r.hub.begin({ host: '127.0.0.1', port: r.port })

    // The agent's own machine sees everything ...
    const status = await (await fetch(`http://127.0.0.1:${r.port}/api/agent/pairing/status`)).json()
    expect(status).toMatchObject({ state: 'pending' })
    expect(JSON.stringify(status)).toContain(started.pairingId)

    // ... the operator types the code the HUB shows (and, from another PC, the PIN).
    const agentCode = started.code
    const confirmed = await r.post('/api/agent/pairing/confirm', { code: started.code })
    expect(confirmed.status).toBe(200)
    const view = await r.hub.confirm(started.pairingId, agentCode)
    expect(view.state).toBe('paired')

    expect(isAgentPaired(r.configPath)).toBe(true)
    const raw = read(r.configPath)
    const meshTls = raw['meshTls'] as { certPem: string; caCertPem: string }
    expect(new X509Certificate(meshTls.certPem).subject).toContain(`CN=${NODE_ID}`)
    expect(
      new X509Certificate(meshTls.certPem).verify(new X509Certificate(r.ca.certPem).publicKey),
    ).toBe(true)
    expect(raw['hubAddress']).toBe('hub.example.test')
    // The retired secret is neither read nor removed by pairing.
    expect(raw['secret']).toBe('retired')

    const hello = await (await fetch(`http://127.0.0.1:${r.port}/api/agent/pairing/hello`)).json()
    expect(hello).toMatchObject({ nodeId: NODE_ID, state: 'paired' })
  })

  it('the network cannot confirm: no PIN is 401, a wrong PIN is 401, the PIN from the console works (C1)', async () => {
    const r = current()
    const started = await r.hub.begin({ host: '127.0.0.1', port: r.port })
    const secret = theSecret(r)
    const noPin = await r.post(
      '/api/agent/pairing/confirm',
      { pairingId: started.pairingId, code: started.code },
      REMOTE_HEADERS,
    )
    expect(noPin).toMatchObject({ status: 401, body: { error: 'pin-required' } })
    const wrongPin = await r.post(
      '/api/agent/pairing/confirm',
      { code: started.code, pin: '00000000' },
      REMOTE_HEADERS,
    )
    expect(wrongPin.status).toBe(401)
    const rejectNoPin = await r.post('/api/agent/pairing/reject', {}, REMOTE_HEADERS)
    expect(rejectNoPin.status).toBe(401)
    const ok = await r.post(
      '/api/agent/pairing/confirm',
      { code: started.code, pin: secret.pin },
      REMOTE_HEADERS,
    )
    expect(ok.status).toBe(200)
  })

  it('a status from the network leaks no code, pairing id or PIN; one from this machine has them (C1)', async () => {
    const r = current()
    const started = await r.hub.begin({ host: '127.0.0.1', port: r.port })
    const secret = theSecret(r)
    const remote = await (
      await fetch(`http://127.0.0.1:${r.port}/api/agent/pairing/status`, {
        headers: REMOTE_HEADERS,
      })
    ).text()
    for (const leak of [started.pairingId, started.code, secret.pin, secret.code ?? 'x']) {
      expect(remote).not.toContain(leak)
    }
    expect(JSON.parse(remote)).toMatchObject({ state: 'pending' })
    const local = await (await fetch(`http://127.0.0.1:${r.port}/api/agent/pairing/status`)).text()
    expect(local).toContain(secret.pin)
  })

  it('a loopback peer behind a proxy (any forwarding header) is treated as remote (M9)', async () => {
    const r = current()
    const started = await r.hub.begin({ host: '127.0.0.1', port: r.port })
    for (const header of ['forwarded', 'x-forwarded-host', 'x-real-ip', 'via']) {
      const res = await r.post(
        '/api/agent/pairing/confirm',
        { code: started.code },
        { [header]: 'x' },
      )
      expect(res.status, header).toBe(401)
    }
  })

  it('reset: the network needs the code printed at boot, this machine does not (N1)', async () => {
    const r = current()
    await r.hub.begin({ host: '127.0.0.1', port: r.port })
    const bad = await r.post('/api/agent/pairing/reset', { code: '00000000' }, REMOTE_HEADERS)
    expect(bad).toMatchObject({ status: 401, body: { error: 'reset-code-required' } })
    const noCode = await r.post('/api/agent/pairing/reset', {}, REMOTE_HEADERS)
    expect(noCode.status).toBe(401)
    const ok = await r.post(
      '/api/agent/pairing/reset',
      { code: r.resetCodes[0] ?? '' },
      REMOTE_HEADERS,
    )
    expect(ok.status).toBe(200)
    expect(r.local.size).toBe(0)
    expect((await r.post('/api/agent/pairing/reset', {})).status).toBe(200)
  })

  it('offers are rate limited per source (M4)', async () => {
    const r = current()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push((await r.post('/api/agent/pairing/offer', {})).status)
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })

  it('refuses a second offer once paired, and a wrong code on the agent', async () => {
    const r = current()
    const endpoint = { host: '127.0.0.1', port: r.port }
    const started = await r.hub.begin(endpoint)
    const wrong = started.code === '000000' ? '111111' : '000000'
    const bad = await r.post('/api/agent/pairing/confirm', { code: wrong })
    expect(bad).toMatchObject({ status: 403, body: { error: 'code-mismatch' } })

    await r.post('/api/agent/pairing/confirm', { code: started.code })
    await r.hub.confirm(started.pairingId, started.code)
    await expect(r.hub.begin(endpoint)).rejects.toThrow(/already paired/)
  })

  it('forget (this machine) leaves the hub: the material is erased and the agent offers itself again', async () => {
    const r = current()
    const endpoint = { host: '127.0.0.1', port: r.port }
    const started = await r.hub.begin(endpoint)
    const agentCode = started.code
    await r.post('/api/agent/pairing/confirm', { code: started.code })
    await r.hub.confirm(started.pairingId, agentCode)
    expect(isAgentPaired(r.configPath)).toBe(true)

    const forgot = await r.post('/api/agent/pairing/forget', {})
    expect(forgot.status).toBe(200)
    expect(r.forgotten).toHaveLength(1)
    const raw = read(r.configPath)
    expect(raw['meshTls']).toBeUndefined()
    expect(raw['hubAddress']).toBeUndefined()
    expect(raw['secret']).toBe('retired')
    const hello = await (await fetch(`http://127.0.0.1:${r.port}/api/agent/pairing/hello`)).json()
    expect(hello).toMatchObject({ state: 'unpaired' })

    // And it can be paired again (its previous abandonment budget is untouched: this one completed).
    const again = await r.hub.begin(endpoint)
    expect(again.state).toBe('awaiting-confirmation')
  })

  it('forget on an unpaired agent is refused', async () => {
    const forgot = await current().post('/api/agent/pairing/forget', {})
    expect(forgot).toMatchObject({ status: 409, body: { error: 'not-paired' } })
  })

  it('the hub client refuses a public address before it sends anything', async () => {
    const transport = createHttpAgentPairingTransport({
      fetchFn: async () => {
        throw new Error('must not be called')
      },
    })
    await expect(transport.hello({ host: '8.8.8.8', port: 4444 })).rejects.toThrow(
      /private network/,
    )
    await expect(transport.hello({ host: 'example.com', port: 4444 })).rejects.toThrow(/local name/)
  })

  it('a refusal keeps the agent code', async () => {
    const r = current()
    const transport = createHttpAgentPairingTransport()
    const error = await transport
      .reveal({ host: '127.0.0.1', port: r.port }, { pairingId: 'nope', hubNonce: 'x' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PairingHttpError)
    expect(error).toMatchObject({ status: 404, code: 'no-pairing' })
  })
})
