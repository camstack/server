import { describe, expect, it } from 'vitest'
import {
  type CapRoute,
  CapRouteError,
  type CapRouteSnapshot,
  classifyCapRoute,
} from '../../transport/cap-route.js'

// ---------------------------------------------------------------------------
// classifyCapRoute tests
// ---------------------------------------------------------------------------

describe('classifyCapRoute', () => {
  // Fake snapshot covering the 4 plan-specified test cases.
  // Note: `getInProcessProviderRef` is intentionally omitted — none of the
  // 4 plan cases hit the hub-in-process branch, so the plan's snap literal
  // stays valid per the optional-accessor design.
  // `getHubLocalChildId` and `getAgentChildId` return realistic runner ids
  // that differ from the cap name, exercising the correct childId wiring.
  const snap: CapRouteSnapshot = {
    hubNodeId: 'hub',
    hubLocalChildProvides: (cap: string) => cap === 'stream-broker',
    hubInProcessProvides: (cap: string) => cap === 'device-manager',
    nodeKnowsCap: (nodeId: string, cap: string) =>
      nodeId === 'dev-agent-0' && cap === 'pipeline-executor',
    nodeIsAgent: (nodeId: string) => nodeId.startsWith('dev-agent-'),
    nodeOnline: (nodeId: string) => nodeId !== 'dev-agent-9',
    getHubLocalChildId: (cap: string) => (cap === 'stream-broker' ? 'addon-stream-broker' : null),
    getAgentChildId: (nodeId: string, cap: string) =>
      nodeId === 'dev-agent-0' && cap === 'pipeline-executor' ? 'addon-detection-pipeline' : null,
  }

  it('hub-local UDS child wins for a hub child cap', () => {
    const r = classifyCapRoute('stream-broker', { nodeId: 'hub' }, snap)
    expect(r.kind).toBe('hub-local-uds')
    if (r.kind === 'hub-local-uds') expect(r.childId).toBe('addon-stream-broker')
  })

  it('agent child cap → agent-child-forward', () => {
    const r = classifyCapRoute('pipeline-executor', { nodeId: 'dev-agent-0' }, snap)
    expect(r.kind).toBe('agent-child-forward')
    if (r.kind === 'agent-child-forward') {
      expect(r.agentNodeId).toBe('dev-agent-0')
      expect(r.childId).toBe('addon-detection-pipeline')
    }
  })

  it('unknown cap on offline node → CapRouteError node-offline', () => {
    expect(() => classifyCapRoute('x', { nodeId: 'dev-agent-9' }, snap)).toThrow(/node-offline/)
  })

  it('cap nobody provides → CapRouteError no-provider with rejected routes listed', () => {
    expect(() => classifyCapRoute('ghost', {}, snap)).toThrow(/no-provider/)
  })

  // Additional coverage for hub-in-process branch
  it('hub-in-process branch when ref is available', () => {
    const ref = { invoke: async (_method: string, _args: unknown) => null }
    const snapWithRef: CapRouteSnapshot = {
      ...snap,
      getInProcessProviderRef: (cap: string) => (cap === 'device-manager' ? ref : null),
    }
    const r = classifyCapRoute('device-manager', { nodeId: 'hub' }, snapWithRef)
    expect(r.kind).toBe('hub-in-process')
  })

  it('hub-in-process branch missing ref accessor → no-provider error', () => {
    // hub says it provides it in-process but no ref accessor given — graceful error
    expect(() => classifyCapRoute('device-manager', { nodeId: 'hub' }, snap)).toThrow(/no-provider/)
  })

  it('hub-local-uds branch with no getHubLocalChildId accessor → no-provider error', () => {
    // hubLocalChildProvides returns true but no childId accessor — graceful fallthrough
    const snapWithoutChildId: CapRouteSnapshot = {
      ...snap,
      getHubLocalChildId: undefined,
    }
    expect(() => classifyCapRoute('stream-broker', { nodeId: 'hub' }, snapWithoutChildId)).toThrow(
      /no-provider/,
    )
  })

  it('singleton resolution falls through to remote-moleculer', () => {
    const snapWithRemote: CapRouteSnapshot = {
      ...snap,
      nodeKnowsCap: (nodeId: string, cap: string) =>
        nodeId === 'remote-node-1' && cap === 'analytics',
      nodeIsAgent: () => false,
      nodeOnline: () => true,
      listKnownNodeIds: () => ['remote-node-1'],
    }
    const r = classifyCapRoute('analytics', {}, snapWithRemote)
    expect(r.kind).toBe('remote-moleculer')
  })

  it('agent-child-forward branch with no getAgentChildId accessor → returns agent-child-forward route with undefined childId', () => {
    // The hub cannot resolve which forked child under the agent provides the cap.
    // When getAgentChildId is absent, childId is undefined — the agent resolves its
    // own child locally (Task 6). A no-provider error is NOT thrown here.
    const snapWithoutAgentChildId: CapRouteSnapshot = {
      ...snap,
      getAgentChildId: undefined,
    }
    const r = classifyCapRoute(
      'pipeline-executor',
      { nodeId: 'dev-agent-0' },
      snapWithoutAgentChildId,
    )
    expect(r.kind).toBe('agent-child-forward')
    if (r.kind === 'agent-child-forward') {
      expect(r.agentNodeId).toBe('dev-agent-0')
      expect(r.childId).toBeUndefined()
    }
  })

  it('online agent node that does NOT know the cap → no-provider error (not remote-moleculer)', () => {
    // dev-agent-0 is online and is an agent, but 'ghost' is not in its registry
    expect(() => classifyCapRoute('ghost', { nodeId: 'dev-agent-0' }, snap)).toThrow(/no-provider/)
  })
})

// ---------------------------------------------------------------------------
// Explicit hub pin — node-accurate hub-resident check
//
// Regression for the shm frame-plane cross-node decode storm: the hub's
// in-process lookup (`createInProcessProviderLookup`) falls back to the
// cluster-elected ACTIVE singleton, which can be a REMOTE-proxy-backed
// provider registered in the hub registry. A call explicitly pinned to the
// hub (`nodePin('hub')`) then classified as `hub-in-process` but executed on
// a remote node — violating the pin (and the shm ring's node-locality).
// The optional node-accurate accessors (`hubResidentProvides` /
// `getHubResidentProviderRef`) let classifyExplicitNode honor the pin.
// ---------------------------------------------------------------------------

describe('classifyCapRoute — explicit hub pin uses node-accurate hub-resident accessors', () => {
  const electedRemoteRef = { invoke: async (_m: string, _a: unknown) => 'remote-elected' }
  const hubResidentRef = { invoke: async (_m: string, _a: unknown) => 'hub-resident' }

  const base: CapRouteSnapshot = {
    hubNodeId: 'hub',
    hubLocalChildProvides: () => false,
    // Legacy elected-based lookup: TRUE for 'decoder' because the cluster
    // elected a remote provider (registered in the hub registry as a proxy).
    hubInProcessProvides: (cap: string) => cap === 'decoder',
    getInProcessProviderRef: (cap: string) => (cap === 'decoder' ? electedRemoteRef : null),
    nodeKnowsCap: (nodeId: string, cap: string) => nodeId === 'mac-agent' && cap === 'decoder',
    nodeIsAgent: (nodeId: string) => nodeId === 'mac-agent',
    nodeOnline: () => true,
    listKnownNodeIds: () => ['mac-agent'],
  }

  it('pinned to hub with NO hub-resident provider → no-provider (must NOT dispatch the elected remote proxy as hub-in-process)', () => {
    const snap: CapRouteSnapshot = {
      ...base,
      hubResidentProvides: () => false,
      getHubResidentProviderRef: () => null,
    }
    expect(() => classifyCapRoute('decoder', { nodeId: 'hub' }, snap)).toThrow(/no-provider/)
  })

  it('pinned to hub with a hub-resident provider → hub-in-process with the RESIDENT ref', async () => {
    const snap: CapRouteSnapshot = {
      ...base,
      hubResidentProvides: (cap: string) => cap === 'decoder',
      getHubResidentProviderRef: (cap: string) => (cap === 'decoder' ? hubResidentRef : null),
    }
    const r = classifyCapRoute('decoder', { nodeId: 'hub' }, snap)
    expect(r.kind).toBe('hub-in-process')
    if (r.kind === 'hub-in-process') {
      await expect(r.ref.invoke('createSession', {})).resolves.toBe('hub-resident')
    }
  })

  it('pinned to hub with no resident provider still falls through to a hub-local UDS child', () => {
    const snap: CapRouteSnapshot = {
      ...base,
      hubResidentProvides: () => false,
      getHubResidentProviderRef: () => null,
      hubLocalChildProvides: (cap: string) => cap === 'decoder',
      getHubLocalChildId: (cap: string) => (cap === 'decoder' ? 'decoder-ffmpeg' : null),
    }
    const r = classifyCapRoute('decoder', { nodeId: 'hub' }, snap)
    expect(r.kind).toBe('hub-local-uds')
    if (r.kind === 'hub-local-uds') expect(r.childId).toBe('decoder-ffmpeg')
  })

  it('UNPINNED singleton keeps the legacy elected-based lookup (election adherence unchanged)', () => {
    const snap: CapRouteSnapshot = {
      ...base,
      hubResidentProvides: () => false,
      getHubResidentProviderRef: () => null,
    }
    const r = classifyCapRoute('decoder', {}, snap)
    expect(r.kind).toBe('hub-in-process')
  })

  it('back-compat: snapshot WITHOUT the node-accurate accessors keeps legacy pinned behavior', () => {
    const r = classifyCapRoute('decoder', { nodeId: 'hub' }, base)
    expect(r.kind).toBe('hub-in-process')
  })
})

describe('CapRoute', () => {
  it('CapRouteError carries a typed reason and the rejected routes', () => {
    const err = new CapRouteError('pipeline-executor', 'getSchema', {
      reason: 'no-provider',
      nodeId: 'dev-agent-0',
      rejected: [{ kind: 'hub-local-uds', why: 'no hub-local child provides it' }],
    })
    expect(err.reason).toBe('no-provider')
    expect(err.message).toContain('pipeline-executor.getSchema')
    expect(err.message).toContain('dev-agent-0')
    expect(err.message).toContain('hub-local-uds')
    expect(err.rejected).toHaveLength(1)
  })

  it('CapRoute kinds are exhaustive', () => {
    // Compile-time guard: if a 5th kind is added to the union without listing it
    // here, `allKinds` fails to satisfy `Record<CapRoute['kind'], true>` and tsc errors.
    const allKinds = {
      'hub-in-process': true,
      'hub-local-uds': true,
      'remote-moleculer': true,
      'agent-child-forward': true,
    } satisfies Record<CapRoute['kind'], true>
    expect(Object.keys(allKinds)).toHaveLength(4)
  })
})
