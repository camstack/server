import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeMeshLeaf,
  ensureTlsCert,
  generateMeshCa,
  issueAgentHttpsLeaf,
  issueMeshLeafForNode,
  issueMeshLeafFromCsr,
  type MeshCaSigner,
} from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentNodeCertificates } from '../agent-node-certificates.js'
import type { SniffingListener } from '../agent-sniffing-listener.js'

const NODE = 'agent-1'
const DAY = 86_400_000
const facts = {
  hostname: 'agent-1',
  networkInterfaces: { eth0: [{ address: '10.0.0.20', internal: false }] },
}

let dir: string
let hubDir: string
let ca: MeshCaSigner
let reconnects: number
let forgets: number
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
let swapped: Array<{ keyPem: string; certPem: string }>
let clock: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-certs-'))
  hubDir = mkdtempSync(join(tmpdir(), 'hub-certs-'))
  ca = await generateMeshCa()
  const leaf = await issueMeshLeafForNode(ca, NODE)
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      nodeId: NODE,
      hubAddress: '192.0.2.10',
      meshTls: { certPem: leaf.certPem, keyPem: leaf.keyPem, caCertPem: ca.certPem },
    }),
  )
  reconnects = 0
  forgets = 0
  timers = []
  swapped = []
  clock = Date.now()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(hubDir, { recursive: true, force: true })
})

function provider() {
  const listener: SniffingListener = {
    port: 0,
    setMaterial: (m) => {
      swapped.push({ keyPem: m.keyPem, certPem: m.certPem })
      return true
    },
    tlsRefusedCount: () => 0,
    close: async () => undefined,
  }
  const lines: string[] = []
  const p = createAgentNodeCertificates({
    nodeId: NODE,
    dataDir: dir,
    configPath: join(dir, 'agent.json'),
    reconnect: async () => {
      reconnects += 1
    },
    forgetHub: () => {
      forgets += 1
    },
    getHttpsListener: () => listener,
    hostFacts: facts,
    now: () => clock,
    log: {
      info: (m) => void lines.push(m),
      warn: (m) => void lines.push(m),
      error: (m) => void lines.push(m),
    },
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return {
        cancel: () => {
          entry.cancelled = true
        },
      }
    },
  })
  return { p, lines }
}

const file = () =>
  JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown>
const liveTimer = (ms: number) => timers.find((t) => t.ms === ms && !t.cancelled)

async function renewWith(p: ReturnType<typeof provider>['p'], confirmWithinMs = 60_000) {
  const { csrPem } = await p.prepareMeshRenewal({})
  const signed = await issueMeshLeafFromCsr(ca, csrPem, { expectedNodeId: NODE })
  return {
    signed,
    install: () =>
      p.installMeshLeaf({ certPem: signed.certPem, caCertPem: ca.certPem, confirmWithinMs }),
  }
}

describe('forgetHub (D857)', () => {
  it('answers the hub and asks the agent to leave it - nothing is erased inside the call itself', async () => {
    const { p, lines } = provider()
    await expect(p.forgetHub({})).resolves.toEqual({ ok: true })
    expect(forgets).toBe(1)
    expect(lines.some((l) => l.includes('unpaired this agent'))).toBe(true)
  })
})

describe('agent mesh leaf swap', () => {
  it('persists the new leaf BESIDE the old one with its swap state, and forgets the old one only on confirm', async () => {
    const { p } = provider()
    const before = file()['meshTls'] as { certPem: string; keyPem: string }
    const { signed, install } = await renewWith(p)
    const installed = await install()
    const after = file()
    expect((after['meshTls'] as { certPem: string }).certPem).toBe(signed.certPem)
    expect((after['meshTls'] as { keyPem: string }).keyPem).not.toBe(before.keyPem)
    expect((after['meshTlsPrevious'] as { certPem: string }).certPem).toBe(before.certPem)
    expect(after['meshSwap']).toMatchObject({ fingerprint: installed.fingerprintSha256 })
    liveTimer(400)?.fn()
    await Promise.resolve()
    expect(reconnects).toBe(1)

    expect(await p.confirmMeshLeaf({ fingerprintSha256: 'wrong' })).toEqual({ confirmed: false })
    expect(file()['meshTlsPrevious']).toBeDefined()
    expect(await p.confirmMeshLeaf({ fingerprintSha256: installed.fingerprintSha256 })).toEqual({
      confirmed: true,
    })
    expect(file()['meshTlsPrevious']).toBeUndefined()
    expect(file()['meshSwap']).toBeUndefined()
  })

  it('with no confirmation the node puts the previous (still valid) leaf back by itself and reconnects', async () => {
    const { p } = provider()
    const before = file()['meshTls'] as { certPem: string }
    const { install } = await renewWith(p)
    await install()
    liveTimer(60_000)?.fn()
    await Promise.resolve()
    expect((file()['meshTls'] as { certPem: string }).certPem).toBe(before.certPem)
    expect(file()['meshTlsPrevious']).toBeUndefined()
    expect(file()['meshSwap']).toBeUndefined()
    expect(liveTimer(400)).toBeDefined()
  })

  it('an explicit rollback restores the previous leaf; with nothing pending it refuses', async () => {
    const { p } = provider()
    expect(await p.rollbackMeshLeaf({})).toEqual({ rolledBack: false })
    const { install } = await renewWith(p)
    await install()
    expect(await p.rollbackMeshLeaf({})).toEqual({ rolledBack: true })
  })

  it('refuses a leaf for another key, a foreign CA, or another node - the file is untouched', async () => {
    const { p } = provider()
    const original = JSON.stringify(file())
    await p.prepareMeshRenewal({})
    const other = await issueMeshLeafForNode(ca, NODE)
    await expect(
      p.installMeshLeaf({ certPem: other.certPem, caCertPem: ca.certPem, confirmWithinMs: 60_000 }),
    ).rejects.toThrow(/does not match the key/)
    const stranger = await generateMeshCa()
    const { csrPem } = await p.prepareMeshRenewal({})
    const foreign = await issueMeshLeafFromCsr(stranger, csrPem, { expectedNodeId: NODE })
    await expect(
      p.installMeshLeaf({
        certPem: foreign.certPem,
        caCertPem: stranger.certPem,
        confirmWithinMs: 60_000,
      }),
    ).rejects.toThrow(/not the CA this node trusts/)
    expect(JSON.stringify(file())).toBe(original)
  })

  it('getCertificates reports the mesh leaf and an HTTPS state that never reads as an empty "none"', async () => {
    const { p } = provider()
    const answer = await p.getCertificates({})
    expect(answer.nodeId).toBe(NODE)
    expect(answer.mesh?.cn).toBe(NODE)
    expect(answer.https.state).toBe('not-issued')
  })
})

describe('SECURITY: a rollback can never restore a stale or expired leaf', () => {
  it('a restart between install and confirm, past the deadline: the swap is settled - a LATER failed renewal still ends on a VALID leaf', async () => {
    const first = provider()
    const { install } = await renewWith(first.p, 60_000)
    await install()
    const swappedIn = file()['meshTls'] as { certPem: string }
    // The agent restarts after the swap's deadline: nothing was confirmed, nothing was rolled back.
    clock += 5 * 60_000
    timers = []
    const second = provider()
    expect((file()['meshTls'] as { certPem: string }).certPem).toBe(swappedIn.certPem)
    expect(file()['meshTlsPrevious']).toBeUndefined() // leftovers dropped at boot
    expect(file()['meshSwap']).toBeUndefined()

    // A later renewal fails (the hub never confirms): the node ends on a leaf that is valid.
    const { install: installAgain } = await renewWith(second.p, 60_000)
    const beforeFailure = file()['meshTls'] as { certPem: string }
    await installAgain()
    liveTimer(60_000)?.fn()
    await Promise.resolve()
    const final = file()['meshTls'] as { certPem: string }
    expect(final.certPem).toBe(beforeFailure.certPem)
    expect(describeMeshLeaf(final.certPem).notAfter).toBeGreaterThan(clock)
  })

  it('a leftover EXPIRED previous leaf with no pending swap is deleted at boot and by the next renewal - never a rollback target', async () => {
    const expired = await issueMeshLeafForNode(ca, NODE, {
      now: new Date(clock - 40 * DAY),
      validDays: 30,
    })
    const raw = file()
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        ...raw,
        meshTlsPrevious: {
          certPem: expired.certPem,
          keyPem: expired.keyPem,
          caCertPem: ca.certPem,
        },
      }),
    )
    const { p, lines } = provider()
    expect(file()['meshTlsPrevious']).toBeUndefined()
    expect(lines.some((l) => l.includes('leftovers removed at boot'))).toBe(true)
    // Put it back and fail a renewal: the renewal clears it before anything can go back to it.
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        ...file(),
        meshTlsPrevious: {
          certPem: expired.certPem,
          keyPem: expired.keyPem,
          caCertPem: ca.certPem,
        },
      }),
    )
    const current = (file()['meshTls'] as { certPem: string }).certPem
    const { install } = await renewWith(p)
    await install()
    liveTimer(60_000)?.fn()
    await Promise.resolve()
    expect((file()['meshTls'] as { certPem: string }).certPem).toBe(current)
  })

  it('refuses to go back to an expired previous leaf even while a swap is pending - it keeps the current one', async () => {
    const { p, lines } = provider()
    const { install } = await renewWith(p, 60_000)
    await install()
    const raw = file()
    const expired = await issueMeshLeafForNode(ca, NODE, {
      now: new Date(clock - 40 * DAY),
      validDays: 30,
    })
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        ...raw,
        meshTlsPrevious: {
          certPem: expired.certPem,
          keyPem: expired.keyPem,
          caCertPem: ca.certPem,
        },
      }),
    )
    const current = (file()['meshTls'] as { certPem: string }).certPem
    expect(await p.rollbackMeshLeaf({})).toEqual({ rolledBack: false })
    expect((file()['meshTls'] as { certPem: string }).certPem).toBe(current)
    expect(lines.some((l) => l.includes('previous leaf is gone or expired'))).toBe(true)
  })

  it('a swap still pending at boot re-arms its rollback instead of being forgotten', async () => {
    const first = provider()
    const before = file()['meshTls'] as { certPem: string }
    const { install } = await renewWith(first.p, 5 * 60_000)
    await install()
    clock += 60_000 // restart one minute later: the deadline is still ahead
    timers = []
    provider()
    const rearm = timers.find((t) => !t.cancelled && t.ms >= 10_000)
    expect(rearm).toBeDefined()
    rearm?.fn()
    await Promise.resolve()
    expect((file()['meshTls'] as { certPem: string }).certPem).toBe(before.certPem)
  })
})

describe('agent HTTPS leaf', () => {
  it('prepare -> hub signs the public key for the observed address -> install hot-swaps the listener; one atomic bundle', async () => {
    await ensureTlsCert(hubDir)
    const { p } = provider()
    const prepared = await p.prepareHttpsCertificate({})
    expect(prepared.csrPem).not.toContain('PRIVATE KEY')
    expect(prepared.addresses).toContain('10.0.0.20')
    const issued = await issueAgentHttpsLeaf({
      hubDataDir: hubDir,
      nodeId: NODE,
      csrPem: prepared.csrPem,
      reportedNames: [...prepared.hostnames, ...prepared.addresses],
      observedAddress: '10.0.0.20',
    })
    const leaf = await p.installHttpsCertificate({
      certPem: issued.certPem,
      caCertPem: issued.caCertPem,
    })
    expect(leaf.sans.join(',')).toContain('10.0.0.20')
    expect(swapped).toHaveLength(1)
    expect(swapped[0]?.certPem).toBe(issued.certPem)
    expect(existsSync(join(dir, 'tls', 'agent-https.json'))).toBe(true)
    expect((await p.getCertificates({})).https.state).toBe('served')
  })

  it('a corrupt bundle on disk does not throw: HTTPS reads as not issued and the problem is logged', async () => {
    const { p, lines } = provider()
    mkdirSync(join(dir, 'tls'), { recursive: true })
    writeFileSync(join(dir, 'tls', 'agent-https.json'), '{ broken')
    const answer = await p.getCertificates({})
    expect(answer.https.state).toBe('not-issued')
    expect(lines.some((l) => l.includes('unusable'))).toBe(true)
  })
})
