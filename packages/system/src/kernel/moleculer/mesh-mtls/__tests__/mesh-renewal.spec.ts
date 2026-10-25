import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeStore } from '../../../../builtins/local-auth/__tests__/memory-settings-store.js'
import {
  createMeshCsrPem,
  generateMeshCa,
  generateMeshKeyPair,
  issueMeshLeafForNode,
  type MeshCaSigner,
} from '../mesh-ca.js'
import {
  describeMeshLeaf,
  MeshCertificateRegistry,
  RENEWAL_ABANDONED,
} from '../mesh-certificate-registry.js'
import { MeshCrl } from '../mesh-crl.js'
import type { MeshPeerLeaf } from '../mesh-peer-transport.js'
import {
  type MeshPeers,
  type NodeMeshClient,
  renewMeshCertificate,
  revokeMeshCertificate,
} from '../mesh-renewal.js'

const NODE = 'agent-1'

function leafOf(certPem: string): MeshPeerLeaf {
  const d = describeMeshLeaf(certPem)
  return {
    serial: d.serial,
    fingerprint: d.fingerprint,
    notBefore: d.notBefore,
    notAfter: d.notAfter,
  }
}

/** Wait for a condition (key generation and signing take real time, more under load). */
const until = async (condition: () => boolean): Promise<void> => {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > 4_000) throw new Error('condition not reached in time')
    await new Promise((resolve) => setImmediate(resolve))
  }
}
/** Let already-resolved work settle, for asserting that something did NOT happen. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface World {
  readonly ca: MeshCaSigner
  readonly registry: MeshCertificateRegistry
  readonly crl: MeshCrl
  readonly calls: string[]
  readonly lines: string[]
  readonly oldCertPem: string
  /** The hub's registration-completion events, driven by hand. */
  readonly registrations: {
    subscribe(l: (nodeId: string, addonIds?: readonly string[]) => void): () => void
    emit(nodeId: string, addonIds?: readonly string[]): void
    count(): number
  }
  /** The single deadline timer, fired by hand. */
  readonly deadline: { fire(): void; armed(): boolean }
  now: number
}

const silentLog = (lines: string[]) => ({
  info: (m: string) => void lines.push(`info ${m}`),
  warn: (m: string) => void lines.push(`warn ${m}`),
  error: (m: string) => void lines.push(`error ${m}`),
})

async function world(): Promise<World> {
  const ca = await generateMeshCa()
  const store = makeStore() as unknown as SettingsStoreClient
  const registry = new MeshCertificateRegistry(store)
  const old = await issueMeshLeafForNode(ca, NODE)
  await registry.recordIssued(NODE, old.certPem, 'enroll')
  const listeners = new Set<(nodeId: string, addonIds?: readonly string[]) => void>()
  let timerFn: (() => void) | null = null
  const w: World = {
    ca,
    registry,
    crl: new MeshCrl(),
    calls: [],
    lines: [],
    oldCertPem: old.certPem,
    registrations: {
      subscribe: (l) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      emit: (nodeId, addonIds) => {
        for (const l of [...listeners]) l(nodeId, addonIds)
      },
      count: () => listeners.size,
    },
    deadline: {
      fire: () => timerFn?.(),
      armed: () => timerFn !== null,
    },
    now: 0,
  }
  ;(w as { setTimer?: unknown }).setTimer = (fn: () => void) => {
    timerFn = fn
    return {
      cancel: () => {
        timerFn = null
      },
    }
  }
  return w
}

interface NodeState {
  presented: MeshPeerLeaf
  installed: MeshPeerLeaf | null
  confirmFailures: number
}

/** A node that really makes a key + CSR; it reconnects only when the test says so. */
function fakeNode(
  w: World,
  state: NodeState,
  opts: { installFails?: boolean } = {},
): { client: NodeMeshClient; peers: MeshPeers } {
  const client: NodeMeshClient = {
    prepareMeshRenewal: async () => {
      w.calls.push('prepare')
      const keys = await generateMeshKeyPair()
      return { csrPem: await createMeshCsrPem(keys, NODE) }
    },
    installMeshLeaf: async (input) => {
      w.calls.push('install')
      if (opts.installFails === true) throw new Error('disk full')
      state.installed = leafOf(input.certPem)
      return { fingerprintSha256: 'x', serial: 'y' }
    },
    confirmMeshLeaf: async () => {
      w.calls.push(`confirm(oldRevoked=${w.crl.list().length > 0})`)
      if (state.confirmFailures > 0) {
        state.confirmFailures -= 1
        throw new Error('node-certificates is not routable yet')
      }
      return { confirmed: true }
    },
    rollbackMeshLeaf: async () => {
      w.calls.push('rollback')
      return { rolledBack: true }
    },
  }
  const peers: MeshPeers = {
    peerLeaf: () => state.presented,
    dropPeer: () => {
      w.calls.push('drop')
      return 1
    },
  }
  return { client, peers }
}

function renew(
  w: World,
  node: ReturnType<typeof fakeNode>,
  extra: { timeoutMs?: number; expectedAddons?: readonly string[] } = {},
) {
  const setTimer = (
    w as unknown as { setTimer: (fn: () => void, ms: number) => { cancel(): void } }
  ).setTimer
  return renewMeshCertificate({
    nodeId: NODE,
    client: node.client,
    ca: w.ca,
    registry: w.registry,
    crl: w.crl,
    peers: node.peers,
    registrations: w.registrations,
    ...(extra.expectedAddons !== undefined
      ? { expectedAddons: () => extra.expectedAddons ?? [] }
      : {}),
    log: silentLog(w.lines),
    reconnectTimeoutMs: extra.timeoutMs ?? 2_000,
    confirmRetryMs: 100,
    setTimer,
    now: () => w.now,
    sleep: async (ms) => {
      w.now += ms
    },
  })
}

describe('MeshCertificateRegistry', () => {
  it('records an issued leaf once, an unknown observed leaf as `observed`, and survives a reload', async () => {
    const w = await world()
    const again = await w.registry.recordIssued(NODE, w.oldCertPem, 'enroll')
    expect(w.registry.list(NODE)).toHaveLength(1)
    expect(again.issuedVia).toBe('enroll')

    const other = await issueMeshLeafForNode(w.ca, 'agent-2')
    const leaf = describeMeshLeaf(other.certPem)
    expect(await w.registry.recordObserved('agent-2', leaf)).toBe(true)
    expect(await w.registry.recordObserved('agent-2', leaf)).toBe(false)
    expect(w.registry.currentFor('agent-2')).toMatchObject({ issuedVia: 'observed' })

    const store = makeStore() as unknown as SettingsStoreClient
    const first = new MeshCertificateRegistry(store)
    await first.recordIssued(NODE, w.oldCertPem, 'enroll')
    await first.revoke(describeMeshLeaf(w.oldCertPem).fingerprint, 'test')
    const reloaded = new MeshCertificateRegistry(store)
    await reloaded.load()
    const crl = new MeshCrl()
    expect(reloaded.restoreCrl(crl)).toBe(1)
    expect(crl.isRevoked(describeMeshLeaf(w.oldCertPem).serial)).toBe(true)
  })

  it('INCIDENT 2026-10-15: a node seen presenting its PREVIOUS leaf sets the unconfirmed renewal leaf aside at once', async () => {
    let now = 1_000
    const store = makeStore() as unknown as SettingsStoreClient
    const registry = new MeshCertificateRegistry(store, { now: () => now })
    const ca = await generateMeshCa()
    const old = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, old.certPem, 'enroll')
    now += 60_000
    const fresh = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, fresh.certPem, 'renewal')
    // Both live: the newer (renewal) one reads as current although the swap never confirmed.
    expect(registry.currentFor(NODE)?.issuedVia).toBe('renewal')

    // The node rolled back and registers presenting the previous leaf.
    expect(await registry.recordObserved(NODE, describeMeshLeaf(old.certPem))).toBe(true)

    expect(registry.currentFor(NODE)?.fingerprint).toBe(describeMeshLeaf(old.certPem).fingerprint)
    const aside = registry.list(NODE).find((r) => r.issuedVia === 'renewal')
    expect(aside).toMatchObject({ revokedReason: RENEWAL_ABANDONED })
    // Set aside, never on the CRL: the node may still hold it.
    expect(registry.isRevoked(describeMeshLeaf(fresh.certPem).serial)).toBe(false)
    // And if the node is later seen with it after all, it is current again.
    expect(await registry.recordObserved(NODE, describeMeshLeaf(fresh.certPem))).toBe(true)
    expect(registry.currentFor(NODE)?.issuedVia).toBe('renewal')
  })

  it('a renewal leaf still in flight is not set aside when the node presents the OLD leaf first', async () => {
    let now = 1_000
    const store = makeStore() as unknown as SettingsStoreClient
    const registry = new MeshCertificateRegistry(store, { now: () => now })
    const ca = await generateMeshCa()
    const old = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, old.certPem, 'enroll')
    now += 60_000
    const fresh = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, fresh.certPem, 'renewal')
    const freshFp = describeMeshLeaf(fresh.certPem).fingerprint

    registry.beginRenewal(freshFp)
    expect(await registry.recordObserved(NODE, describeMeshLeaf(old.certPem))).toBe(false)
    expect(registry.liveFor(NODE)).toHaveLength(2) // no set-aside / reinstate flapping

    registry.endRenewal(freshFp)
    expect(await registry.recordObserved(NODE, describeMeshLeaf(old.certPem))).toBe(true)
    expect(registry.currentFor(NODE)?.issuedVia).toBe('enroll')
  })

  it('observing the leaf that IS the newest changes nothing', async () => {
    let now = 1_000
    const store = makeStore() as unknown as SettingsStoreClient
    const registry = new MeshCertificateRegistry(store, { now: () => now })
    const ca = await generateMeshCa()
    const old = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, old.certPem, 'enroll')
    now += 60_000
    const fresh = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, fresh.certPem, 'renewal')
    expect(await registry.recordObserved(NODE, describeMeshLeaf(fresh.certPem))).toBe(false)
    expect(registry.liveFor(NODE)).toHaveLength(2)
  })

  it('reap() removes revoked rows past retention and keeps live ones (so boot rows do not pile up)', async () => {
    let now = 1_000
    const store = makeStore() as unknown as SettingsStoreClient
    const registry = new MeshCertificateRegistry(store, { now: () => now })
    const ca = await generateMeshCa()
    const a = await issueMeshLeafForNode(ca, 'hub')
    await registry.recordIssued('hub', a.certPem, 'boot')
    await registry.revoke(describeMeshLeaf(a.certPem).fingerprint, 'superseded')
    const b = await issueMeshLeafForNode(ca, 'hub')
    await registry.recordIssued('hub', b.certPem, 'boot')
    now += 91 * 86_400_000
    expect(await registry.reap()).toBe(1)
    expect(registry.list('hub')).toHaveLength(1)
  })
})

describe('renewMeshCertificate - the node must be REGISTERED, not just handshaken', () => {
  it('SECURITY: confirm waits for the registration; the old serial goes on the CRL only after', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    expect(w.calls).toEqual(['prepare', 'install'])

    // 1. The TLS handshake lands with the new leaf. The node has NO capabilities yet.
    state.presented = state.installed ?? state.presented
    await settle()
    expect(w.calls).toEqual(['prepare', 'install']) // confirm has NOT been called
    expect(w.crl.list()).toEqual([])

    // 2. registerNode lands: now - and only now - the hub confirms and retires the old leaf.
    w.registrations.emit(NODE)
    const result = await done
    if (!result.ok) throw new Error(result.reason)
    expect(w.calls).toEqual(['prepare', 'install', 'confirm(oldRevoked=false)'])
    expect(w.crl.isRevoked(describeMeshLeaf(w.oldCertPem).serial)).toBe(true)
    expect(w.crl.isRevoked(result.newSerial)).toBe(false)
    expect(w.registry.liveFor(NODE)).toHaveLength(1)
    expect(w.registry.currentFor(NODE)?.issuedVia).toBe('renewal')
    // No extra disconnect after the node came back: the capless window is a normal reconnect.
    expect(w.calls).not.toContain('drop')
    expect(w.registrations.count()).toBe(0)
  })

  it('a registration while the node still presents the OLD leaf does not count', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    w.registrations.emit(NODE) // old connection re-registers
    await settle()
    expect(w.calls).toEqual(['prepare', 'install'])
    state.presented = state.installed ?? state.presented
    w.registrations.emit(NODE)
    expect((await done).ok).toBe(true)
  })

  it('retries the confirm while the node capability is not routable yet', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 2,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    state.presented = state.installed ?? state.presented
    w.registrations.emit(NODE)
    const result = await done
    expect(result.ok).toBe(true)
    expect(w.calls.filter((c) => c.startsWith('confirm'))).toHaveLength(3)
    expect(w.crl.isRevoked(describeMeshLeaf(w.oldCertPem).serial)).toBe(true)
  })

  it('INCIDENT 2026-10-15: a registration that lost the node children is not "back"; the one that has them again is', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const before = ['agent-runtime', 'pipeline-runner', 'ml-runner']
    const done = renew(w, node, { expectedAddons: before })
    await until(() => w.calls.includes('install'))
    state.presented = state.installed ?? state.presented

    // The node came back capless: its first registration carries only the core addon.
    w.registrations.emit(NODE, ['agent-runtime'])
    await settle()
    expect(w.calls).toEqual(['prepare', 'install']) // NOT confirmed, nothing revoked
    expect(w.crl.list()).toEqual([])
    expect(w.lines.some((l) => l.includes('registered without addons'))).toBe(true)

    // The registration that carries every child again settles it.
    w.registrations.emit(NODE, before)
    expect((await done).ok).toBe(true)
    expect(w.calls.filter((c) => c.startsWith('confirm'))).toHaveLength(1)
  })

  it('a node that only ever registers without its children times out and says which addons it lost', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node, { expectedAddons: ['agent-runtime', 'pipeline-runner'] })
    await until(() => w.calls.includes('install'))
    state.presented = state.installed ?? state.presented
    w.registrations.emit(NODE, ['agent-runtime'])
    w.deadline.fire()
    const result = await done
    expect(result).toMatchObject({ ok: false, stage: 'reconnect', keptPreviousLeaf: true })
    if (!result.ok) expect(result.reason).toContain('pipeline-runner')
    expect(w.calls).toEqual(['prepare', 'install', 'rollback'])
    expect(w.crl.list()).toEqual([])
  })

  it('INCIDENT 2026-10-15: a confirm answered "transport-failed ... is not found" is retried to the deadline', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    let attempts = 0
    const confirm = node.client.confirmMeshLeaf
    node.client.confirmMeshLeaf = async (input) => {
      attempts += 1
      if (attempts <= 3) {
        throw new Error(
          "node-certificates.confirmMeshLeaf not routable to node agent-1: transport-failed (rejected: agent-child-forward=Service '$agent-cap-fwd.forward' is not found on 'agent-1' node.)",
        )
      }
      return confirm(input)
    }
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    state.presented = state.installed ?? state.presented
    w.registrations.emit(NODE)
    expect((await done).ok).toBe(true)
    expect(attempts).toBe(4)
  })

  it('SECURITY: a swap that never registers keeps the old leaf valid, rolls back, and sets the new leaf aside', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    expect(w.deadline.armed()).toBe(true)
    w.deadline.fire() // the deadline passes without a registration
    const result = await done
    expect(result).toMatchObject({ ok: false, stage: 'reconnect', keptPreviousLeaf: true })
    expect(w.calls).toEqual(['prepare', 'install', 'rollback'])
    expect(w.crl.list()).toEqual([])
    // The unused new leaf is NOT the node's current leaf, and not on the CRL.
    expect(w.registry.currentFor(NODE)?.fingerprint).toBe(
      describeMeshLeaf(w.oldCertPem).fingerprint,
    )
    const aside = w.registry.list(NODE).find((r) => r.issuedVia === 'renewal')
    expect(aside).toMatchObject({ revokedReason: RENEWAL_ABANDONED })
    expect(w.registrations.count()).toBe(0)
  })

  it('an abandoned leaf the node is later SEEN presenting is reinstated (nothing cut off)', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    w.deadline.fire()
    await done
    const aside = w.registry.list(NODE).find((r) => r.issuedVia === 'renewal')
    if (aside === undefined) throw new Error('no renewal row')
    expect(
      await w.registry.recordObserved(NODE, {
        cn: NODE,
        serial: aside.serial,
        fingerprint: aside.fingerprint,
        notBefore: aside.notBefore,
        notAfter: aside.notAfter,
      }),
    ).toBe(true)
    expect(
      w.registry.list(NODE).find((r) => r.fingerprint === aside.fingerprint)?.revokedAt,
    ).toBeNull()
  })

  it('an install that fails keeps the old leaf and reports the stage', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state, { installFails: true })
    const result = await renew(w, node)
    expect(result).toMatchObject({
      ok: false,
      stage: 'install',
      reason: 'disk full',
      keptPreviousLeaf: true,
    })
    expect(w.crl.list()).toEqual([])
    expect(w.registrations.count()).toBe(0)
  })

  it('records a node enrolled before the registry from the leaf it presents (backfill) before renewing', async () => {
    const w = await world()
    const legacy = await issueMeshLeafForNode(w.ca, NODE)
    const state: NodeState = {
      presented: leafOf(legacy.certPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    state.presented = state.installed ?? state.presented
    w.registrations.emit(NODE)
    await done
    const observed = w.registry.list(NODE).find((r) => r.issuedVia === 'observed')
    expect(observed?.fingerprint).toBe(describeMeshLeaf(legacy.certPem).fingerprint)
    expect(observed?.revokedAt).not.toBeNull()
  })
})

describe('revokeMeshCertificate', () => {
  it('puts the live leaf on the CRL, disconnects the node, and says it must re-join (it is NOT forgotten)', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const { peers } = fakeNode(w, state)
    const result = await revokeMeshCertificate({
      nodeId: NODE,
      registry: w.registry,
      crl: w.crl,
      peers,
      log: silentLog(w.lines),
    })
    expect(result.revokedSerials).toEqual([describeMeshLeaf(w.oldCertPem).serial])
    expect(result.disconnected).toBe(1)
    expect(result.next).toMatch(/Pair it again/)
    expect(result.next).toMatch(/Forget node/)
    expect(w.crl.isRevoked(describeMeshLeaf(w.oldCertPem).serial)).toBe(true)
    expect(w.registry.liveFor(NODE)).toHaveLength(0)
  })
})

describe('revoking a node revokes EVERY leaf of it (stolen-box scenario)', () => {
  it('SECURITY: a leaf the hub had set aside is put on the CRL too, and is never reinstated afterwards', async () => {
    const w = await world()
    const state: NodeState = {
      presented: leafOf(w.oldCertPem),
      installed: null,
      confirmFailures: 0,
    }
    const node = fakeNode(w, state)
    const done = renew(w, node)
    await until(() => w.calls.includes('install'))
    w.deadline.fire() // the renewal never registered: its new leaf is SET ASIDE (not on the CRL)
    await done
    const aside = w.registry.list(NODE).find((r) => r.issuedVia === 'renewal')
    if (aside === undefined) throw new Error('no renewal row')
    expect(aside.revokedReason).toBe(RENEWAL_ABANDONED)
    expect(w.crl.isRevoked(aside.serial)).toBe(false)

    // The box is stolen: a copy of the set-aside leaf's key may exist. The operator revokes the node.
    const result = await revokeMeshCertificate({
      nodeId: NODE,
      registry: w.registry,
      crl: w.crl,
      peers: node.peers,
      log: silentLog(w.lines),
    })
    expect(result.revokedSerials.toSorted()).toEqual(
      [describeMeshLeaf(w.oldCertPem).serial, aside.serial].toSorted(),
    )
    expect(w.crl.isRevoked(describeMeshLeaf(w.oldCertPem).serial)).toBe(true)
    expect(w.crl.isRevoked(aside.serial)).toBe(true)

    // Seen presenting the set-aside leaf later (the thief connects): NOT reinstated.
    const reinstated = await w.registry.recordObserved(NODE, {
      cn: NODE,
      serial: aside.serial,
      fingerprint: aside.fingerprint,
      notBefore: aside.notBefore,
      notAfter: aside.notAfter,
    })
    expect(reinstated).toBe(false)
    expect(w.registry.liveFor(NODE)).toHaveLength(0)
    expect(w.crl.isRevoked(aside.serial)).toBe(true)
  })

  it('a hub restart mid-renewal sets the in-flight renewal leaf aside at boot (not current, not on the CRL)', async () => {
    const w = await world()
    const inFlight = await issueMeshLeafForNode(w.ca, NODE)
    await w.registry.recordIssued(NODE, inFlight.certPem, 'renewal') // issued, then the hub stopped
    expect(w.registry.liveFor(NODE)).toHaveLength(2)
    expect(await w.registry.settleInterruptedRenewals()).toBe(1)
    expect(w.registry.currentFor(NODE)?.fingerprint).toBe(
      describeMeshLeaf(w.oldCertPem).fingerprint,
    )
    expect(w.crl.list()).toEqual([])
    // If the node did adopt it, it is seen presenting it and comes back.
    const leaf = describeMeshLeaf(inFlight.certPem)
    expect(await w.registry.recordObserved(NODE, leaf)).toBe(true)
    expect(w.registry.liveFor(NODE)).toHaveLength(2)
  })
})
