import type { SettingsStoreClient } from '@camstack/types'
import {
  describeMeshLeaf,
  generateMeshCa,
  issueMeshLeafForNode,
  MeshCertificateRegistry,
  MeshCrl,
  type MeshPeerLeaf,
} from '@camstack/system'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { NodeCertificatesClient } from '../../../core/agent/node-certificates-client.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createCertificatesRouter } from '../certificates.router.js'

const admin: AuthenticatedAgent = {
  id: 'u-admin',
  username: 'admin',
  isAdmin: true,
  permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
  isApiKey: false,
  interactive: true,
  userDelegated: true,
  scopes: ['*'],
}

const status = {
  mode: 'generated' as const,
  leafFingerprintSha256: 'AA:BB',
  caFingerprintSha256: 'CC:DD',
  validTo: '2027-01-01T00:00:00.000Z',
  sans: ['192.0.2.10'],
  caCertPem: '-----BEGIN CERTIFICATE-----',
  reissueError: null,
  restartRequired: false,
}

const httpsLeaf = {
  fingerprintSha256: 'EE:FF',
  issuer: 'CN=CamStack Local CA',
  sans: ['IP Address:192.0.2.50', 'DNS:agent-1'],
  notBefore: 1,
  notAfter: Date.parse('2027-02-01T00:00:00Z'),
}

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
    query: { query: async (a: { collection: string }) => [...coll(a.collection).values()] },
  }
  return store as unknown as SettingsStoreClient
}

interface SetupOptions {
  agentHttps?: 'served' | 'not-issued'
  agentOnline?: boolean
  /** The names registry is not loaded yet. */
  namesUnavailable?: boolean
  /** The node's install call fails (the answer is lost). */
  installFails?: boolean
  /** The CA fingerprint the node pinned at its first install. */
  pinnedCa?: string | null
  /** A real CA PEM for the leaf the hub "signs" (the router fingerprints it). */
  caPem?: string
}

async function setup(opts: SetupOptions = {}) {
  const gate: { promise: Promise<void>; open(): void } = (() => {
    let open: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      open = resolve
    })
    return { promise, open }
  })()
  gate.open() // not blocking unless a test closes it first
  const listener: {
    current: { state: 'open' } | { state: 'closed'; reason: string; since: number }
  } = {
    current: { state: 'open' },
  }
  const takenByOthers = new Set<string>(['192.0.2.99'])
  const recorded: Array<{ nodeId: string; names: readonly string[] }> = []
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const crl = new MeshCrl()
  const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
  await registry.recordIssued('hub', hubLeaf.certPem, 'boot')
  // agent-1 enrolled before the registry existed: only its live connection knows its leaf.
  const legacy = await issueMeshLeafForNode(ca, 'agent-1')
  const presented: { current: MeshPeerLeaf | undefined } = {
    current: {
      serial: describeMeshLeaf(legacy.certPem).serial,
      fingerprint: describeMeshLeaf(legacy.certPem).fingerprint,
      notBefore: describeMeshLeaf(legacy.certPem).notBefore,
      notAfter: describeMeshLeaf(legacy.certPem).notAfter,
      // The address of the node's LIVE mesh socket, as the hub sees it.
      remoteAddress: '192.0.2.50',
    },
  }
  const calls: string[] = []
  const client: NodeCertificatesClient = {
    getCertificates: async () => ({
      nodeId: 'agent-1',
      mesh: null,
      https:
        opts.agentHttps === 'served'
          ? { state: 'served', leaf: httpsLeaf }
          : {
              state: 'not-issued',
              reason: 'No hub-issued HTTPS certificate has been installed on this node yet.',
            },
    }),
    prepareMeshRenewal: async () => {
      throw new Error('not used here')
    },
    installMeshLeaf: async () => {
      throw new Error('not used here')
    },
    confirmMeshLeaf: async () => {
      throw new Error('not used here')
    },
    rollbackMeshLeaf: async () => ({ rolledBack: false }),
    forgetHub: async () => ({ ok: true as const }),
    prepareHttpsCertificate: async () => {
      calls.push('prepare-https')
      await gate.promise
      return {
        csrPem: 'CSR',
        hostnames: ['bank.example.com'],
        addresses: ['203.0.113.77'],
        pinnedCaFingerprintSha256: opts.pinnedCa ?? null,
      }
    },
    installHttpsCertificate: async (input) => {
      calls.push(`install-https${input.caRotation === true ? '(rotation)' : ''}`)
      if (opts.installFails === true) throw new Error('the answer was lost')
      return httpsLeaf
    },
  }
  const regenerated: string[] = []
  const router = createCertificatesRouter({
    registry: {
      getSingleton: (name: string) =>
        name === 'local-network'
          ? {
              getTlsStatus: async () => status,
              regenerateCertificate: async () => {
                regenerated.push('hub')
                return status
              },
            }
          : null,
    } as never,
    agentRegistry: {
      listNodeLiveness: () => [
        { id: 'hub', isHub: true, isOnline: true },
        { id: 'agent-1', isHub: false, isOnline: opts.agentOnline ?? true },
      ],
    },
    nodeClient: (id) => (id === 'agent-1' ? client : null),
    hubDataDir: '/nonexistent',
    httpsNames: () =>
      opts.namesUnavailable === true
        ? null
        : {
            takenByOthers: () => takenByOthers,
            record: async (nodeId, names) => void recorded.push({ nodeId, names }),
          },
    registrations: { subscribe: () => () => undefined },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    meshRegistry: () => registry,
    crl: () => crl,
    meshCa: () => ca,
    peers: { peerLeaf: () => presented.current, dropPeer: () => 1 },
    issueHttps: async (input) => {
      calls.push(
        `issue(${input.nodeId},observed=${input.observedAddress ?? ''},reported=${(input.reportedNames ?? []).join('+')},taken=${[...(input.takenByOthers ?? [])].join('+')})`,
      )
      return {
        certPem: 'CERT',
        caCertPem: opts.caPem ?? 'CA',
        accepted: ['agent-1', '192.0.2.50'],
        rejected: [],
      }
    },
    reconnectTimeoutMs: 100,
    sleep: async () => undefined,
    listenerState: () => listener.current,
  })
  const ctx: TrpcContext = { user: admin }
  return {
    caller: router.createCaller(ctx),
    calls,
    regenerated,
    registry,
    crl,
    legacy,
    recorded,
    presented,
    listener,
  }
}

async function setupBlocked(blocked: Promise<void>) {
  const base = await setup()
  void base
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const router = createCertificatesRouter({
    registry: { getSingleton: () => null } as never,
    agentRegistry: { listNodeLiveness: () => [{ id: 'agent-1', isHub: false, isOnline: true }] },
    nodeClient: () =>
      ({
        getCertificates: async () => ({
          nodeId: 'agent-1',
          mesh: null,
          https: { state: 'not-issued', reason: 'x' },
        }),
        prepareMeshRenewal: async () => {
          await blocked
          throw new Error('stop')
        },
        installMeshLeaf: async () => ({ fingerprintSha256: 'x', serial: 'y' }),
        confirmMeshLeaf: async () => ({ confirmed: true }),
        rollbackMeshLeaf: async () => ({ rolledBack: false }),
        forgetHub: async () => ({ ok: true as const }),
        prepareHttpsCertificate: async () => {
          await blocked
          return { csrPem: 'CSR', hostnames: [], addresses: [], pinnedCaFingerprintSha256: null }
        },
        installHttpsCertificate: async () => httpsLeaf,
      }) satisfies NodeCertificatesClient,
    hubDataDir: '/x',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    meshRegistry: () => registry,
    crl: () => new MeshCrl(),
    meshCa: () => ca,
    peers: {
      peerLeaf: () => ({
        serial: 's',
        fingerprint: 'f',
        notBefore: 1,
        notAfter: 2,
        remoteAddress: '192.0.2.50',
      }),
      dropPeer: () => 0,
    },
    issueHttps: async () => ({
      certPem: 'CERT',
      caCertPem: 'CA',
      accepted: ['agent-1'],
      rejected: [],
    }),
    httpsNames: () => ({ takenByOthers: () => new Set<string>(), record: async () => undefined }),
    registrations: { subscribe: () => () => undefined },
  })
  return { caller: router.createCaller({ user: admin }) }
}

describe('certificates router - HTTPS', () => {
  it('the hub reports its real status; an agent without a leaf says so with the reason (never an empty "none")', async () => {
    const { caller } = await setup()
    const rows = await caller.listHttpsCertificates()
    expect(rows.find((r) => r.nodeId === 'hub')?.https).toMatchObject({
      kind: 'served',
      status: { leafFingerprintSha256: 'AA:BB' },
    })
    const agent = rows.find((r) => r.nodeId === 'agent-1')
    expect(agent?.https).toMatchObject({ kind: 'not-served' })
    if (agent?.https.kind === 'not-served') expect(agent.https.reason).toMatch(/No hub-issued/)
  })

  it('shows a REAL leaf for an agent that has one, and `unreadable` (not "none") for an offline agent', async () => {
    const served = await setup({ agentHttps: 'served' })
    const row = (await served.caller.listHttpsCertificates()).find((r) => r.nodeId === 'agent-1')
    expect(row?.https).toMatchObject({
      kind: 'served',
      status: { leafFingerprintSha256: 'EE:FF', sans: ['IP Address:192.0.2.50', 'DNS:agent-1'] },
    })
    const offline = await setup({ agentOnline: false })
    const off = (await offline.caller.listHttpsCertificates()).find((r) => r.nodeId === 'agent-1')
    expect(off?.https.kind).toBe('unreadable')
  })

  it('renews the hub through regenerateCertificate and an agent through prepare -> hub signs -> install', async () => {
    const { caller, calls, regenerated } = await setup()
    await caller.renewHttpsOnNode({ nodeId: 'hub' })
    expect(regenerated).toEqual(['hub'])
    const status2 = await caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    expect(status2.leafFingerprintSha256).toBe('EE:FF')
    expect(calls).toEqual([
      'prepare-https',
      'issue(agent-1,observed=192.0.2.50,reported=bank.example.com+203.0.113.77,taken=192.0.2.99)',
      'install-https',
    ])
    await expect(caller.renewHttpsOnNode({ nodeId: 'ghost' })).rejects.toThrow(/not reachable/)
  })

  it('records the names it signed (so no other node can get them) and refuses an agent with no live mesh socket', async () => {
    const { caller, recorded, presented } = await setup()
    await caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    expect(recorded).toEqual([{ nodeId: 'agent-1', names: ['agent-1', '192.0.2.50'] }])
    presented.current = undefined
    await expect(caller.renewHttpsOnNode({ nodeId: 'agent-1' })).rejects.toThrow(
      /no live mesh connection/,
    )
  })

  it('SECURITY: a second certificate operation on the same node while one runs is refused (CONFLICT), not interleaved', async () => {
    const world = await setup()
    // Close the gate: the first renewal blocks inside the node.
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = await setupBlocked(blocked)
    const first = slow.caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    await new Promise((r) => setImmediate(r))
    await expect(slow.caller.renewHttpsOnNode({ nodeId: 'agent-1' })).rejects.toThrow(
      /already running/,
    )
    await expect(slow.caller.renewMeshOnNode({ nodeId: 'agent-1' })).rejects.toThrow(
      /already running/,
    )
    release()
    await first
    // Once it finished the node is free again.
    await world.caller.renewHttpsOnNode({ nodeId: 'agent-1' })
  })
})

describe('certificates router - HTTPS safety (third review)', () => {
  it('SECURITY: with the names registry not loaded the hub signs NOTHING', async () => {
    const { caller, calls } = await setup({ namesUnavailable: true })
    await expect(caller.renewHttpsOnNode({ nodeId: 'agent-1' })).rejects.toThrow(
      /names registry is not loaded/,
    )
    expect(calls.some((c) => c.startsWith('issue('))).toBe(false)
    expect(calls).not.toContain('install-https')
  })

  it('records the names BEFORE the install answer: a lost answer leaves them taken, never free', async () => {
    const { caller, recorded } = await setup({ installFails: true })
    await expect(caller.renewHttpsOnNode({ nodeId: 'agent-1' })).rejects.toThrow(/answer was lost/)
    expect(recorded).toEqual([{ nodeId: 'agent-1', names: ['agent-1', '192.0.2.50'] }])
  })

  it('signals a CA ROTATION to the node only when the CA it pinned is not the one signing now', async () => {
    const real = (await generateMeshCa()).certPem
    const fingerprint = new X509Certificate(real).fingerprint256
    const rotated = await setup({ caPem: real, pinnedCa: 'AA:BB:OLD' })
    await rotated.caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    expect(rotated.calls).toContain('install-https(rotation)')
    const same = await setup({ caPem: real, pinnedCa: fingerprint })
    await same.caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    expect(same.calls).toContain('install-https')
    expect(same.calls).not.toContain('install-https(rotation)')
    const first = await setup({ caPem: real, pinnedCa: null })
    await first.caller.renewHttpsOnNode({ nodeId: 'agent-1' })
    expect(first.calls).not.toContain('install-https(rotation)')
  })

  it('shows the mesh listener state (closed + reason) so the admin page can say agents are refused', async () => {
    const { caller, listener } = await setup()
    expect((await caller.getMeshCertificates()).listener).toEqual({ state: 'open' })
    listener.current = {
      state: 'closed',
      reason: 'the revocation registry has not loaded',
      since: 7,
    }
    expect((await caller.getMeshCertificates()).listener).toEqual({
      state: 'closed',
      reason: 'the revocation registry has not loaded',
      since: 7,
    })
  })
})

describe('certificates router - mesh', () => {
  it('backfills a node enrolled before the registry from the leaf it presents, and lists every node with its expiry', async () => {
    const { caller, registry, legacy } = await setup()
    expect(registry.list('agent-1')).toHaveLength(0)
    const mesh = await caller.getMeshCertificates()
    expect(mesh.registryAvailable).toBe(true)
    const agent = mesh.nodes.find((n) => n.nodeId === 'agent-1')
    expect(agent?.current).toMatchObject({
      issuedVia: 'observed',
      fingerprintSha256: describeMeshLeaf(legacy.certPem).fingerprint,
      status: 'valid',
    })
    expect(agent?.presentingCurrent).toBe(true)
    expect(mesh.nodes.find((n) => n.nodeId === 'hub')?.current?.issuedVia).toBe('boot')
  })

  it('revoking puts the serial on the CRL and disconnects, WITHOUT forgetting the node', async () => {
    const { caller, crl, legacy } = await setup()
    const result = await caller.revokeMeshOnNode({ nodeId: 'agent-1' })
    expect(result.revokedSerials).toEqual([describeMeshLeaf(legacy.certPem).serial])
    expect(result.disconnected).toBe(1)
    expect(result.next).toMatch(/Pair it again/)
    expect(crl.isRevoked(describeMeshLeaf(legacy.certPem).serial)).toBe(true)
    const after = await caller.getMeshCertificates()
    expect(after.revokedSerials).toContain(
      describeMeshLeaf(legacy.certPem).serial.replace(/^0x/i, '').toLowerCase(),
    )
    expect(after.nodes.find((n) => n.nodeId === 'agent-1')?.current).toBeNull()
    await expect(caller.revokeMeshOnNode({ nodeId: 'hub' })).rejects.toThrow(
      /re-issued at every boot/,
    )
  })

  it('is admin only', async () => {
    const { caller: _ } = await setup()
    const router = createCertificatesRouter({
      registry: null,
      agentRegistry: { listNodeLiveness: () => [] },
      nodeClient: () => null,
      hubDataDir: '/x',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    const viewer = router.createCaller({
      user: {
        ...admin,
        isAdmin: false,
        permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
      },
    })
    await expect(viewer.getMeshCertificates()).rejects.toThrow()
  })
})
