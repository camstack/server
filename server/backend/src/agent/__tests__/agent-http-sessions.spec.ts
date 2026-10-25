/**
 * Unlock sessions and the loopback rule on the agent's :4444 (D857, security review):
 *  - a ticket is redeemed once, only if issued after the agent booted;
 *  - a session dies when the CA that vouched for it is replaced;
 *  - a loopback peer behind a proxy (any forwarding header) is not this machine.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AgentPairing,
  caFingerprintCompact,
  generateMeshCa,
  issueMeshLeafForNode,
  mintAgentUiUnlockTicket,
} from '@camstack/system'
import type { ServiceBroker } from 'moleculer'
import { afterAll, describe, expect, it } from 'vitest'
import { createAgentHttpServer } from '../agent-http.js'
import { isAgentPaired } from '../agent-pairing-store.js'

const REMOTE = '192.168.10.50'
const NODE = 'test-agent'

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

async function build(options: { meshTls: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-transition-'))
  const configPath = path.join(dir, 'agent.json')
  const ca = await generateMeshCa()
  const leaf = await issueMeshLeafForNode(ca, NODE)
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...(options.meshTls
        ? {
            meshTls: {
              certPem: leaf.certPem,
              keyPem: leaf.keyPem,
              caCertPem: ca.certPem,
            },
          }
        : {}),
    }),
  )
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
  return { app, ca, configPath }
}

describe('agent :4444 - sessions', () => {
  it('redeems a ticket signed by the pinned CA once, and refuses another CA', async () => {
    const { app, ca } = await build({ meshTls: true })
    const other = await generateMeshCa()
    const redeem = (ticket: string) =>
      app.inject({
        method: 'POST',
        url: '/api/agent/session',
        remoteAddress: REMOTE,
        payload: { ticket },
      })
    expect(
      (
        await redeem(
          mintAgentUiUnlockTicket({
            caKeyPem: other.keyPem,
            nodeId: NODE,
          }),
        )
      ).statusCode,
    ).toBe(401)
    const ticket = mintAgentUiUnlockTicket({
      caKeyPem: ca.keyPem,
      nodeId: NODE,
    })
    const ok = await redeem(ticket)
    expect(ok.statusCode).toBe(200)
    expect((await redeem(ticket)).statusCode).toBe(401)
    const token = (ok.json() as { token: string }).token
    const status = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: REMOTE,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(status.statusCode).toBe(200)
  })

  it('an agent paired by certificate with NO secret is locked: no open first-boot surface', async () => {
    const { app } = await build({ meshTls: true })
    for (const [method, url] of [
      ['GET', '/api/agent/status'],
      ['GET', '/api/agent/config'],
      ['POST', '/api/agent/config'],
      ['POST', '/api/agent/restart'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        remoteAddress: REMOTE,
        payload: {},
      })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it('a factory-fresh agent offers the network only the pairing protocol, the same as a paired one', async () => {
    const fresh = await build({ meshTls: false })
    expect(
      (
        await fresh.app.inject({
          method: 'GET',
          url: '/api/agent/status',
          remoteAddress: REMOTE,
        })
      ).statusCode,
    ).toBe(401)
    const paired = await build({ meshTls: true })
    for (const { app } of [fresh, paired]) {
      const hello = await app.inject({
        method: 'GET',
        url: '/api/agent/pairing/hello',
        remoteAddress: REMOTE,
      })
      expect(hello.statusCode).toBe(200)
    }
    // forget is never part of it
    const forget = await paired.app.inject({
      method: 'POST',
      url: '/api/agent/pairing/forget',
      remoteAddress: REMOTE,
      payload: {},
    })
    expect(forget.statusCode).toBe(401)
  })

  it('a ticket issued well before the agent booted is refused, one within the skew margin is not (L12, N7)', async () => {
    const { app, ca } = await build({ meshTls: true })
    const stale = mintAgentUiUnlockTicket({
      caKeyPem: ca.keyPem,
      nodeId: NODE,
      nowMs: Date.now() - 200_000,
    })
    const refused = await app.inject({
      method: 'POST',
      url: '/api/agent/session',
      remoteAddress: REMOTE,
      payload: { ticket: stale },
    })
    expect(refused.statusCode).toBe(401)
    const near = await app.inject({
      method: 'POST',
      url: '/api/agent/session',
      remoteAddress: REMOTE,
      payload: {
        ticket: mintAgentUiUnlockTicket({
          caKeyPem: ca.keyPem,
          nodeId: NODE,
          nowMs: Date.now() - 30_000,
        }),
      },
    })
    expect(near.statusCode).toBe(200)
  })

  it('a session dies when the CA that vouched for it is replaced (M8)', async () => {
    const { app, ca, configPath } = await build({ meshTls: true })
    const redeemed = await app.inject({
      method: 'POST',
      url: '/api/agent/session',
      remoteAddress: REMOTE,
      payload: { ticket: mintAgentUiUnlockTicket({ caKeyPem: ca.keyPem, nodeId: NODE }) },
    })
    const token = (redeemed.json() as { token: string }).token
    const status = () =>
      app.inject({
        method: 'GET',
        url: '/api/agent/status',
        remoteAddress: REMOTE,
        headers: { authorization: `Bearer ${token}` },
      })
    expect((await status()).statusCode).toBe(200)
    // The agent is paired with another hub: the old hub's session is worth nothing.
    const other = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(other, NODE)
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        meshTls: {
          certPem: leaf.certPem,
          keyPem: leaf.keyPem,
          caCertPem: other.certPem,
        },
      }),
    )
    expect((await status()).statusCode).toBe(401)
  })

  it('a loopback peer behind a proxy is not trusted: a forwarding header makes it remote (M9)', async () => {
    const { app } = await build({ meshTls: true })
    const direct = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: '127.0.0.1',
    })
    expect(direct.statusCode).toBe(200)
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'via']) {
      const proxied = await app.inject({
        method: 'GET',
        url: '/api/agent/status',
        remoteAddress: '127.0.0.1',
        headers: { [header]: '192.168.10.99' },
      })
      expect(proxied.statusCode, header).toBe(401)
    }
  })

  it('an unpaired agent with pairing mounted takes no remote config write or restart (M6)', async () => {
    const { app } = await build({ meshTls: false })
    for (const url of ['/api/agent/config', '/api/agent/restart']) {
      const remote = await app.inject({
        method: 'POST',
        url,
        remoteAddress: REMOTE,
        payload: {},
      })
      expect(remote.statusCode, url).toBe(401)
    }
    // Nor does it read out its state to the network: the page learns that it is unpaired
    // from the public unlock-info and then shows the pairing protocol (D857).
    const read = await app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: REMOTE,
    })
    expect(read.statusCode).toBe(401)
    const info = await app.inject({
      method: 'GET',
      url: '/api/agent/unlock-info',
      remoteAddress: REMOTE,
    })
    expect(info.json()).toMatchObject({ paired: false, nodeId: NODE })
  })

  it('reports the hub it is paired with, and none while unpaired (agent UI card)', async () => {
    const paired = await build({ meshTls: true })
    const status = await paired.app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: '127.0.0.1',
    })
    const body: { pairedHub?: { caFingerprint: string } | null } = status.json()
    expect(body.pairedHub?.caFingerprint).toBe(caFingerprintCompact(paired.ca.certPem))

    const fresh = await build({ meshTls: false })
    const unpaired = await fresh.app.inject({
      method: 'GET',
      url: '/api/agent/status',
      remoteAddress: '127.0.0.1',
    })
    expect(unpaired.json().pairedHub).toBeNull()
  })

  it("lets a loopback write an unpaired agent's name and hub hint; a remote caller cannot", async () => {
    const { app } = await build({ meshTls: false })
    const rename = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      payload: { name: 'kitchen' },
    })
    expect(rename.statusCode).toBe(200)
    const retarget = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
      payload: { hubAddress: '10.0.0.1' },
    })
    expect(retarget.statusCode).toBe(200)
    const remote = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      remoteAddress: REMOTE,
      payload: { hubAddress: '10.0.0.2' },
    })
    expect(remote.statusCode).toBe(401)
  })

  it('never echoes key material in GET config, including the previous mesh material (N8)', async () => {
    const { app, configPath } = await build({ meshTls: true })
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...raw,
        meshTlsPrevious: raw['meshTls'],
        joinToken: 'tok',
        name: 'visible',
      }),
    )
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/config',
      remoteAddress: '127.0.0.1',
    })
    expect(res.body).toContain('visible')
    for (const leak of ['meshTls', 'meshTlsPrevious', 'joinToken', 'PRIVATE KEY']) {
      expect(res.body, leak).not.toContain(leak)
    }
  })
})
