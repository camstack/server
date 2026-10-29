/**
 * A refused agent resets to `unpaired` ONLY on a CA-signed `revoked`, read twice (D857, D49).
 *
 * The first block pins the decision with a scripted hub answer. The second wires the real pieces - the
 * hub's routes and registry, the agent's client, its `agent.json` - so "forgotten on the hub" becomes
 * "pairable again on the agent" end to end, and a hub that merely cannot be reached costs it nothing.
 */
import { X509Certificate } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  generateMeshCa,
  issueMeshLeafForNode,
  MembershipResponder,
  MeshCertificateRegistry,
  MeshCrl,
} from '@camstack/system'
import type { SettingsStoreClient } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMeshMembershipRoutes } from '../../api/mesh-membership-routes'
import { AgentMembershipWatch } from '../agent-membership-watch'
import {
  forgetPairing,
  isAgentPaired,
  persistPairing,
  readPairedHubIdentity,
} from '../agent-pairing-store'
import {
  askHubMembership,
  type HubMembershipResult,
  type MembershipFetch,
} from '../hub-membership-client'

const GRACE = 1_000
const ASK = 5_000
const CONFIRM = 2_000

function scripted(answers: readonly HubMembershipResult[]) {
  const queue = [...answers]
  const onRevoked = vi.fn(async (_reason: string) => undefined)
  const ask = vi.fn(async (): Promise<HubMembershipResult> => {
    const next = queue.shift()
    if (next === undefined) throw new Error('asked more often than scripted')
    return next
  })
  const lines: string[] = []
  const log = {
    warn: (m: string, e?: { tags?: Record<string, string> }) =>
      lines.push(`warn ${e?.tags?.['nodeId'] ?? 'NO-TAG'} ${m}`),
    info: (m: string, e?: { tags?: Record<string, string> }) =>
      lines.push(`info ${e?.tags?.['nodeId'] ?? 'NO-TAG'} ${m}`),
  }
  let connected = false
  let paired = true
  const watch = new AgentMembershipWatch({
    nodeId: 'agent-old',
    isPaired: () => paired,
    isConnected: () => connected,
    ask,
    onRevoked,
    log,
    graceMs: GRACE,
    askIntervalMs: ASK,
    confirmDelayMs: CONFIRM,
  })
  return {
    watch,
    ask,
    onRevoked,
    lines,
    setConnected: (v: boolean) => (connected = v),
    setPaired: (v: boolean) => (paired = v),
  }
}

const revoked: HubMembershipResult = {
  kind: 'answer',
  answer: { status: 'revoked', reason: 'forgotten' },
}

describe('AgentMembershipWatch - when it asks', () => {
  it('does not ask while connected, while unpaired, or inside the grace period', async () => {
    const t = scripted([])
    t.setConnected(true)
    await t.watch.tick(0)
    await t.watch.tick(60_000)
    t.setConnected(false)
    t.setPaired(false)
    await t.watch.tick(120_000)
    t.setPaired(true)
    await t.watch.tick(121_000)
    await t.watch.tick(121_000 + GRACE - 1)
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('asks after the grace period and then at its own interval', async () => {
    const t = scripted([
      { kind: 'answer', answer: { status: 'member' } },
      { kind: 'answer', answer: { status: 'member' } },
    ])
    await t.watch.tick(0)
    await t.watch.tick(GRACE)
    await t.watch.tick(GRACE + ASK - 1)
    expect(t.ask).toHaveBeenCalledTimes(1)
    await t.watch.tick(GRACE + ASK)
    expect(t.ask).toHaveBeenCalledTimes(2)
  })
})

describe('AgentMembershipWatch - when it resets', () => {
  it('resets on `revoked` confirmed by a second read, telling the reason', async () => {
    const t = scripted([revoked, revoked])
    await t.watch.tick(0)
    await t.watch.tick(GRACE)
    expect(t.onRevoked).not.toHaveBeenCalled()
    await t.watch.tick(GRACE + CONFIRM - 1)
    expect(t.ask).toHaveBeenCalledTimes(1)
    await t.watch.tick(GRACE + CONFIRM)
    expect(t.onRevoked).toHaveBeenCalledTimes(1)
    expect(t.onRevoked).toHaveBeenCalledWith('forgotten')
    expect(t.lines.every((l) => !l.includes('NO-TAG'))).toBe(true)
    expect(t.lines.some((l) => l.startsWith('warn agent-old'))).toBe(true)
  })

  it('does NOT reset when the second read says member (a first `revoked` alone destroys nothing)', async () => {
    const t = scripted([revoked, { kind: 'answer', answer: { status: 'member' } }])
    await t.watch.tick(0)
    await t.watch.tick(GRACE)
    await t.watch.tick(GRACE + CONFIRM)
    expect(t.ask).toHaveBeenCalledTimes(2)
    expect(t.onRevoked).not.toHaveBeenCalled()
  })

  it('does NOT reset on `unknown`, nor on an unreachable hub, even many times', async () => {
    const t = scripted([
      { kind: 'answer', answer: { status: 'unknown' } },
      { kind: 'unreachable', error: 'ECONNREFUSED' },
      revoked,
      { kind: 'unreachable', error: 'timeout' },
      revoked,
    ])
    let at = 0
    await t.watch.tick(at)
    at = GRACE
    for (let i = 0; i < 5; i += 1) {
      await t.watch.tick(at)
      at += ASK
    }
    expect(t.ask).toHaveBeenCalledTimes(5)
    expect(t.onRevoked).not.toHaveBeenCalled()
  })

  it('forgets a half-finished count when the hub comes back', async () => {
    const t = scripted([revoked, revoked])
    await t.watch.tick(0)
    await t.watch.tick(GRACE)
    t.setConnected(true)
    await t.watch.tick(GRACE + 100)
    t.setConnected(false)
    await t.watch.tick(GRACE + 200)
    await t.watch.tick(GRACE + 200 + GRACE)
    expect(t.ask).toHaveBeenCalledTimes(2)
    expect(t.onRevoked).not.toHaveBeenCalled()
  })
})

// --- the real pieces -------------------------------------------------------------------------

function memoryStore(): SettingsStoreClient {
  const rows = new Map<string, Map<string, { id: string; data: Record<string, unknown> }>>()
  const coll = (n: string) => {
    let c = rows.get(n)
    if (c === undefined) {
      c = new Map()
      rows.set(n, c)
    }
    return c
  }
  const store = {
    insert: {
      mutate: async (a: {
        collection: string
        record: { id: string; data: Record<string, unknown> }
      }) => {
        coll(a.collection).set(a.record.id, a.record)
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: a.data })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) =>
        void coll(a.collection).delete(a.key),
    },
    query: {
      query: async (a: { collection: string }) => [...coll(a.collection).values()],
    },
  }
  return store as unknown as SettingsStoreClient
}

const dirs: string[] = []
const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  for (const a of apps.splice(0)) await a.close()
})

async function world() {
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const crl = new MeshCrl()
  const leaf = await issueMeshLeafForNode(ca, 'agent-old')
  await registry.recordIssued('agent-old', leaf.certPem, 'pairing')
  const app = Fastify()
  apps.push(app)
  registerMeshMembershipRoutes(app, {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => {
        throw new Error('unused')
      },
      withTags: () => {
        throw new Error('unused')
      },
    },
    responder: new MembershipResponder({
      registry: () => registry,
      crl: () => crl,
      caKeyPem: () => ca.keyPem,
    }),
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-membership-'))
  dirs.push(dir)
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({ nodeId: 'agent-old', name: 'Old Mac', logLevel: 'debug' }),
  )
  persistPairing(configPath, {
    hubAddress: 'hub.example.test',
    hubUrl: 'https://hub.example.test:4443',
    meshTls: {
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      caCertPem: ca.certPem,
    },
  })
  const viaHub: MembershipFetch = async (url, init) => {
    const res = await app.inject({
      method: 'POST',
      url: new URL(url).pathname,
      headers: { 'content-type': 'application/json' },
      ...(init.body !== undefined ? { payload: init.body } : {}),
    })
    return { status: res.statusCode, json: async () => res.json() }
  }
  const ask = async (doFetch: MembershipFetch): Promise<HubMembershipResult> => {
    const identity = readPairedHubIdentity(configPath)
    if (identity === null || identity.hubUrl === null)
      return { kind: 'unreachable', error: 'not paired' }
    return askHubMembership({ ...identity, hubUrl: identity.hubUrl, nodeId: 'agent-old' }, doFetch)
  }
  return { ca, registry, crl, leaf, configPath, dir, viaHub, ask }
}

function watchOf(w: Awaited<ReturnType<typeof world>>, doFetch: MembershipFetch) {
  const reset = vi.fn(async (_reason: string) => {
    forgetPairing(w.configPath, w.dir)
  })
  const watch = new AgentMembershipWatch({
    nodeId: 'agent-old',
    isPaired: () => isAgentPaired(w.configPath),
    isConnected: () => false,
    ask: () => w.ask(doFetch),
    onRevoked: reset,
    log: { warn: () => undefined, info: () => undefined },
    graceMs: GRACE,
    askIntervalMs: ASK,
    confirmDelayMs: CONFIRM,
  })
  return { watch, reset }
}

describe('a forgotten agent that is powered on again (end to end)', () => {
  it('the leaf is refused, the agent asks, hears `forgotten` twice, and is pairable again', async () => {
    const w = await world()
    expect(isAgentPaired(w.configPath)).toBe(true)
    await w.registry.revokeAllForNode('agent-old', 'forgotten', w.crl)
    const { watch, reset } = watchOf(w, w.viaHub)

    await watch.tick(0)
    await watch.tick(GRACE)
    expect(isAgentPaired(w.configPath)).toBe(true)
    await watch.tick(GRACE + CONFIRM)

    expect(reset).toHaveBeenCalledWith('forgotten')
    expect(isAgentPaired(w.configPath)).toBe(false)
    const after = JSON.parse(fs.readFileSync(w.configPath, 'utf-8')) as Record<string, unknown>
    expect(after).toEqual({
      nodeId: 'agent-old',
      name: 'Old Mac',
      logLevel: 'debug',
    })
  })

  it('a member agent whose hub is merely down keeps its whole pairing', async () => {
    const w = await world()
    const down: MembershipFetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const { watch, reset } = watchOf(w, down)

    let at = 0
    await watch.tick(at)
    at = GRACE
    for (let i = 0; i < 6; i += 1) {
      await watch.tick(at)
      at += ASK
    }

    expect(reset).not.toHaveBeenCalled()
    expect(isAgentPaired(w.configPath)).toBe(true)
    expect(readPairedHubIdentity(w.configPath)?.hubUrl).toBe('https://hub.example.test:4443')
  })

  it('a live leaf is told `member` and is not reset', async () => {
    const w = await world()
    const { watch, reset } = watchOf(w, w.viaHub)
    await watch.tick(0)
    await watch.tick(GRACE)
    await watch.tick(GRACE + CONFIRM)
    expect(reset).not.toHaveBeenCalled()
    expect(isAgentPaired(w.configPath)).toBe(true)
  })

  it('believes no `revoked` that the pinned CA did not sign (a man in the middle)', async () => {
    const w = await world()
    await w.registry.revokeAllForNode('agent-old', 'forgotten', w.crl)
    const other = await world()
    await other.registry.revokeAllForNode('agent-old', 'forgotten', other.crl)
    // The hub that answers is signed by ANOTHER CA than the one this agent pinned.
    const { watch, reset } = watchOf(w, other.viaHub)
    await watch.tick(0)
    await watch.tick(GRACE)
    await watch.tick(GRACE + CONFIRM)
    await watch.tick(GRACE + 2 * CONFIRM)
    expect(reset).not.toHaveBeenCalled()
    expect(isAgentPaired(w.configPath)).toBe(true)
  })

  it('the pinned leaf fingerprint is what the hub answers about', async () => {
    const w = await world()
    const fp = new X509Certificate(w.leaf.certPem).fingerprint256
    const result = await w.ask(w.viaHub)
    expect(result).toEqual({ kind: 'answer', answer: { status: 'member' } })
    expect(fp.length).toBeGreaterThan(0)
  })
})
