/**
 * Cap-dispatch MATRIX — exhaustive coverage of every dispatch path.
 *
 * The cap-dispatch story has four orthogonal dimensions:
 *   • TRANSPORT ROUTE   hub-in-process / hub-local-uds / remote-moleculer / agent-child-forward
 *   • CALLER POSITION   explicit hub / explicit online agent / explicit online non-agent
 *                       remote / explicit offline node / no-nodeId (singleton scan)
 *   • CAP TYPE          system in-process / hub-local singleton child / device-scoped
 *                       native (keyed by (capName, deviceId)) / agent child / remote
 *   • DEVICE HINT       opts.deviceId absent / matching / mismatching
 *
 * `classifyCapRoute` is a PURE decision function (no I/O, snapshot of predicates),
 * so every cell of the matrix is deterministic. Part 1 walks the full table at the
 * classifier. Part 2 drives `CapRouteResolver.dispatch` for the cells the existing
 * resolver spec leaves uncovered — chiefly device-scoped NATIVE cross-process
 * dispatch (`${addonId}.native-provider.${cap}.${method}`) and deviceId-keyed
 * hub-local routing, both central to the Reolink-Baichuan late-native-cap saga.
 *
 * Companion specs (not duplicated here): cap-route.spec.ts (representative cases),
 * cap-route-resolver.spec.ts (system-cap dispatch + error wrapping),
 * child-cap-dispatch.spec.ts (end-to-end UDS child dispatch).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  classifyCapRoute,
  CapRouteError,
  type CapRoute,
  type CapRouteReason,
  type CapRouteSnapshot,
  type CapRouteOpts,
  type InProcessProviderRef,
} from '../../transport/cap-route.js'
import {
  CapRouteResolver,
  AGENT_CAP_FWD_ACTION,
  type CapRouteResolverDeps,
  type NodeCapAuthority,
  type HubLocalChildDispatcher,
  type InProcessProviderLookup,
} from '../../transport/cap-route-resolver.js'
import { capActionName } from '../../transport/cap-action-name.js'
import type { ServiceDiscoveryBroker } from '../../moleculer/resilient-cap-call.js'

// ───────────────────────────────────────────────────────────────────────────
// PART 1 — classifyCapRoute matrix (pure)
// ───────────────────────────────────────────────────────────────────────────

const HUB = 'hub'
const IN_PROCESS_REF: InProcessProviderRef = { invoke: async () => null }

// One rich topology exercised by the whole table:
//   in-process (with ref): device-manager, dual-cap
//   in-process (NO ref):   no-ref-cap          (provides=true, ref=null)
//   hub-local singleton:   stream-broker→addon-stream-broker, dual-cap→addon-dual
//   hub-local device native: ptz, but ONLY for deviceId 42 → provider-reolink
//   agent-1 (online, agent):   knows pipeline-executor → child addon-detection-pipeline
//   remote-1 (online, !agent): knows analytics
//   agent-9 / remote-9: offline
const MATRIX_SNAPSHOT: CapRouteSnapshot = {
  hubNodeId: HUB,
  hubInProcessProvides: (cap) =>
    cap === 'device-manager' || cap === 'dual-cap' || cap === 'no-ref-cap',
  getInProcessProviderRef: (cap) =>
    cap === 'device-manager' || cap === 'dual-cap' ? IN_PROCESS_REF : null,
  hubLocalChildProvides: (cap, deviceId) => {
    if (cap === 'stream-broker' || cap === 'dual-cap') return true
    if (cap === 'ptz') return deviceId === 42
    return false
  },
  getHubLocalChildId: (cap, deviceId) => {
    if (cap === 'stream-broker') return 'addon-stream-broker'
    if (cap === 'dual-cap') return 'addon-dual'
    if (cap === 'ptz') return deviceId === 42 ? 'provider-reolink' : null
    return null
  },
  nodeKnowsCap: (nodeId, cap) =>
    (nodeId === 'agent-1' && cap === 'pipeline-executor') ||
    (nodeId === 'remote-1' && cap === 'analytics'),
  nodeIsAgent: (nodeId) => nodeId === 'agent-1' || nodeId === 'agent-9',
  nodeOnline: (nodeId) => nodeId === 'agent-1' || nodeId === 'remote-1',
  listKnownNodeIds: () => ['agent-1', 'agent-9', 'remote-1', 'remote-9'],
  getAgentChildId: (nodeId, cap) =>
    nodeId === 'agent-1' && cap === 'pipeline-executor' ? 'addon-detection-pipeline' : null,
}

type Expectation =
  | { route: 'hub-in-process' }
  | { route: 'hub-local-uds'; childId: string }
  | { route: 'remote-moleculer'; nodeId?: string }
  | { route: 'agent-child-forward'; agentNodeId: string; childId?: string }
  | { error: CapRouteReason }

interface MatrixCell {
  readonly desc: string
  readonly cap: string
  readonly opts: CapRouteOpts
  readonly expect: Expectation
}

const CELLS: readonly MatrixCell[] = [
  // ── caller = explicit hub ──────────────────────────────────────────────
  {
    desc: 'hub: in-process cap with ref → hub-in-process',
    cap: 'device-manager',
    opts: { nodeId: HUB },
    expect: { route: 'hub-in-process' },
  },
  {
    desc: 'hub: in-process cap WITHOUT ref accessor → no-provider',
    cap: 'no-ref-cap',
    opts: { nodeId: HUB },
    expect: { error: 'no-provider' },
  },
  {
    desc: 'hub: hub-local singleton child cap → hub-local-uds',
    cap: 'stream-broker',
    opts: { nodeId: HUB },
    expect: { route: 'hub-local-uds', childId: 'addon-stream-broker' },
  },
  {
    desc: 'hub: device-scoped native cap with MATCHING deviceId → hub-local-uds',
    cap: 'ptz',
    opts: { nodeId: HUB, deviceId: 42 },
    expect: { route: 'hub-local-uds', childId: 'provider-reolink' },
  },
  {
    desc: 'hub: device-scoped native cap with MISMATCHING deviceId → no-provider',
    cap: 'ptz',
    opts: { nodeId: HUB, deviceId: 99 },
    expect: { error: 'no-provider' },
  },
  {
    desc: 'hub: device-scoped native cap with NO deviceId hint → no-provider',
    cap: 'ptz',
    opts: { nodeId: HUB },
    expect: { error: 'no-provider' },
  },
  {
    desc: 'hub: cap nobody provides → no-provider',
    cap: 'ghost',
    opts: { nodeId: HUB },
    expect: { error: 'no-provider' },
  },
  {
    desc: 'hub: PRECEDENCE — in-process wins over a hub-local child of the same name',
    cap: 'dual-cap',
    opts: { nodeId: HUB },
    expect: { route: 'hub-in-process' },
  },

  // ── caller = explicit online agent ─────────────────────────────────────
  {
    desc: 'agent: agent knows the cap → agent-child-forward (childId resolved)',
    cap: 'pipeline-executor',
    opts: { nodeId: 'agent-1' },
    expect: {
      route: 'agent-child-forward',
      agentNodeId: 'agent-1',
      childId: 'addon-detection-pipeline',
    },
  },
  {
    desc: 'agent: online agent does NOT know the cap → no-provider (NOT remote-moleculer)',
    cap: 'ghost',
    opts: { nodeId: 'agent-1' },
    expect: { error: 'no-provider' },
  },

  // ── caller = explicit non-agent online remote ──────────────────────────
  {
    desc: 'remote: online non-agent node, known cap → remote-moleculer',
    cap: 'analytics',
    opts: { nodeId: 'remote-1' },
    expect: { route: 'remote-moleculer', nodeId: 'remote-1' },
  },
  {
    desc: 'remote: online non-agent node TRUSTS the cluster even for an unlisted cap → remote-moleculer',
    cap: 'whatever',
    opts: { nodeId: 'remote-1' },
    expect: { route: 'remote-moleculer', nodeId: 'remote-1' },
  },

  // ── caller = explicit OFFLINE node (liveness checked first) ─────────────
  {
    desc: 'offline: agent node offline → node-offline (checked before agent branch)',
    cap: 'pipeline-executor',
    opts: { nodeId: 'agent-9' },
    expect: { error: 'node-offline' },
  },
  {
    desc: 'offline: remote node offline → node-offline',
    cap: 'analytics',
    opts: { nodeId: 'remote-9' },
    expect: { error: 'node-offline' },
  },

  // ── caller = no nodeId (singleton scan) ────────────────────────────────
  {
    desc: 'singleton: in-process cap → hub-in-process',
    cap: 'device-manager',
    opts: {},
    expect: { route: 'hub-in-process' },
  },
  {
    desc: 'singleton: hub-local child cap → hub-local-uds',
    cap: 'stream-broker',
    opts: {},
    expect: { route: 'hub-local-uds', childId: 'addon-stream-broker' },
  },
  {
    desc: 'singleton: device-scoped native cap with matching deviceId → hub-local-uds',
    cap: 'ptz',
    opts: { deviceId: 42 },
    expect: { route: 'hub-local-uds', childId: 'provider-reolink' },
  },
  {
    desc: 'singleton: device-scoped native cap with mismatching deviceId → no-provider',
    cap: 'ptz',
    opts: { deviceId: 99 },
    expect: { error: 'no-provider' },
  },
  {
    desc: 'singleton: remote non-agent node knows it → remote-moleculer',
    cap: 'analytics',
    opts: {},
    expect: { route: 'remote-moleculer', nodeId: 'remote-1' },
  },
  {
    desc: 'singleton: agent-hosted cap resolves to remote-moleculer (singleton scan never forwards)',
    cap: 'pipeline-executor',
    opts: {},
    expect: { route: 'remote-moleculer', nodeId: 'agent-1' },
  },
  {
    desc: 'singleton: cap nobody provides → no-provider',
    cap: 'ghost',
    opts: {},
    expect: { error: 'no-provider' },
  },
  {
    desc: 'singleton: PRECEDENCE — in-process wins over hub-local + remote',
    cap: 'dual-cap',
    opts: {},
    expect: { route: 'hub-in-process' },
  },
]

describe('cap-dispatch matrix — classifyCapRoute (every caller × cap-type × device-hint cell)', () => {
  CELLS.forEach((cell) => {
    it(cell.desc, () => {
      if ('error' in cell.expect) {
        let thrown: unknown
        try {
          classifyCapRoute(cell.cap, cell.opts, MATRIX_SNAPSHOT)
        } catch (e) {
          thrown = e
        }
        expect(thrown).toBeInstanceOf(CapRouteError)
        expect((thrown as CapRouteError).reason).toBe(cell.expect.error)
        return
      }

      const route: CapRoute = classifyCapRoute(cell.cap, cell.opts, MATRIX_SNAPSHOT)
      expect(route.kind).toBe(cell.expect.route)
      if (cell.expect.route === 'hub-local-uds' && route.kind === 'hub-local-uds') {
        expect(route.childId).toBe(cell.expect.childId)
      }
      if (
        cell.expect.route === 'remote-moleculer' &&
        route.kind === 'remote-moleculer' &&
        cell.expect.nodeId
      ) {
        expect(route.nodeId).toBe(cell.expect.nodeId)
      }
      if (cell.expect.route === 'agent-child-forward' && route.kind === 'agent-child-forward') {
        expect(route.agentNodeId).toBe(cell.expect.agentNodeId)
        expect(route.childId).toBe(cell.expect.childId)
      }
    })
  })

  it('covers all four transport-route kinds at least once', () => {
    const kinds = new Set<string>()
    for (const cell of CELLS) {
      if ('route' in cell.expect) kinds.add(cell.expect.route)
    }
    expect([...kinds].toSorted()).toEqual([
      'agent-child-forward',
      'hub-in-process',
      'hub-local-uds',
      'remote-moleculer',
    ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// PART 2 — CapRouteResolver.dispatch: device-scoped NATIVE + deviceId routing
// (the cells the existing resolver spec leaves uncovered — every prior fake
//  hard-codes isNativeCap:()=>false and a deviceId-blind resolveChildId)
// ───────────────────────────────────────────────────────────────────────────

function makeBroker(): ServiceDiscoveryBroker & { callSpy: ReturnType<typeof vi.fn> } {
  const callSpy = vi.fn(async (_action: string, _params: unknown, _opts: unknown) => ({ ok: true }))
  return { call: callSpy, waitForServices: vi.fn(async () => {}), callSpy }
}

// deviceId-AWARE hub-local registry: a device-scoped native cap is keyed by
// (capName, deviceId), mirroring LocalChildRegistry.resolveChildId.
function makeDeviceAwareHubLocal(
  routes: ReadonlyArray<{ cap: string; deviceId?: number; childId: string }>,
): HubLocalChildDispatcher & { callSpy: ReturnType<typeof vi.fn> } {
  const callSpy = vi.fn(async (_childId: string, _input: unknown) => ({ ok: true, from: 'uds' }))
  return {
    resolveChildId: (cap, deviceId) =>
      routes.find((r) => r.cap === cap && (r.deviceId === undefined || r.deviceId === deviceId))
        ?.childId ?? null,
    callCapOnChild: callSpy,
    callSpy,
  }
}

// isNativeCap-AWARE authority: marks (nodeId, cap[, deviceId]) entries native so
// the remote leg uses the `native-provider` action name.
function makeNativeAwareAuthority(
  specs: ReadonlyArray<{
    nodeId: string
    cap: string
    addonId: string
    agent?: boolean
    native?: boolean
    agentChildId?: string
  }>,
  online: ReadonlySet<string>,
): NodeCapAuthority {
  const find = (nodeId: string, cap: string) =>
    specs.find((s) => s.nodeId === nodeId && s.cap === cap)
  return {
    nodeKnowsCap: (nodeId, cap) => find(nodeId, cap) !== undefined,
    nodeIsAgent: (nodeId) => specs.some((s) => s.nodeId === nodeId && s.agent === true),
    nodeOnline: (nodeId) => online.has(nodeId),
    listNodeIds: () => [...new Set(specs.map((s) => s.nodeId))],
    getAddonId: (nodeId, cap) => find(nodeId, cap)?.addonId ?? null,
    getAgentChildId: (nodeId, cap) => find(nodeId, cap)?.agentChildId ?? null,
    isNativeCap: (nodeId, cap) => find(nodeId, cap)?.native === true,
  }
}

const noInProcess: InProcessProviderLookup = () => null

describe('cap-dispatch matrix — CapRouteResolver native + deviceId dispatch', () => {
  it('remote device-scoped NATIVE cap dispatches via the native-provider action name', async () => {
    const broker = makeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB,
      broker,
      hubLocalRegistry: makeDeviceAwareHubLocal([]),
      nodeAuthority: makeNativeAwareAuthority(
        [{ nodeId: 'remote-1', cap: 'ptz', addonId: 'addon-reolink', native: true }],
        new Set(['remote-1']),
      ),
      inProcessProviders: noInProcess,
    }
    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('ptz', { nodeId: 'remote-1' })
    expect(route.kind).toBe('remote-moleculer')

    await resolver.dispatch(route, 'move', { deviceId: 42, pan: 1 })

    const [action] = broker.callSpy.mock.calls[0] as [string]
    expect(action).toContain('native-provider')
    expect(action).toBe(capActionName('addon-reolink', 'ptz', 'move', true))
  })

  it('remote SYSTEM cap dispatches via the plain action name (no native-provider segment)', async () => {
    const broker = makeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB,
      broker,
      hubLocalRegistry: makeDeviceAwareHubLocal([]),
      nodeAuthority: makeNativeAwareAuthority(
        [{ nodeId: 'remote-1', cap: 'analytics', addonId: 'addon-analytics-suite', native: false }],
        new Set(['remote-1']),
      ),
      inProcessProviders: noInProcess,
    }
    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('analytics', { nodeId: 'remote-1' })

    await resolver.dispatch(route, 'getReport', { period: 'day' })

    const [action] = broker.callSpy.mock.calls[0] as [string]
    expect(action).not.toContain('native-provider')
    expect(action).toBe(capActionName('addon-analytics-suite', 'analytics', 'getReport', false))
  })

  it('device-scoped native hub-local routing keys on (capName, deviceId): matching id routes to the device child', async () => {
    const hubLocal = makeDeviceAwareHubLocal([
      { cap: 'ptz', deviceId: 42, childId: 'provider-reolink' },
    ])
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB,
      broker: makeBroker(),
      hubLocalRegistry: hubLocal,
      nodeAuthority: makeNativeAwareAuthority([], new Set()),
      inProcessProviders: noInProcess,
    }
    const resolver = new CapRouteResolver(deps)

    const route = resolver.resolveCapRoute('ptz', { nodeId: HUB, deviceId: 42 })
    expect(route.kind).toBe('hub-local-uds')
    if (route.kind === 'hub-local-uds') expect(route.childId).toBe('provider-reolink')

    await resolver.dispatch(route, 'move', { deviceId: 42, pan: 1 })
    const [childId, input] = hubLocal.callSpy.mock.calls[0] as [string, { deviceId?: number }]
    expect(childId).toBe('provider-reolink')
    expect(input.deviceId).toBe(42)
  })

  it('device-scoped native hub-local routing rejects a mismatching deviceId → no-provider', () => {
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB,
      broker: makeBroker(),
      hubLocalRegistry: makeDeviceAwareHubLocal([
        { cap: 'ptz', deviceId: 42, childId: 'provider-reolink' },
      ]),
      nodeAuthority: makeNativeAwareAuthority([], new Set()),
      inProcessProviders: noInProcess,
    }
    const resolver = new CapRouteResolver(deps)
    expect(() => resolver.resolveCapRoute('ptz', { nodeId: HUB, deviceId: 99 })).toThrow(
      /no-provider/,
    )
  })

  it('agent-child-forward carries capName, childId and the deviceId hint in the forward params', async () => {
    const broker = makeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB,
      broker,
      hubLocalRegistry: makeDeviceAwareHubLocal([]),
      nodeAuthority: makeNativeAwareAuthority(
        [
          {
            nodeId: 'agent-1',
            cap: 'pipeline-executor',
            addonId: 'addon-detection-pipeline',
            agent: true,
            agentChildId: 'addon-detection-pipeline',
          },
        ],
        new Set(['agent-1']),
      ),
      inProcessProviders: noInProcess,
    }
    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('pipeline-executor', { nodeId: 'agent-1' })
    expect(route.kind).toBe('agent-child-forward')

    await resolver.dispatch(route, 'attachCamera', { deviceId: 7, source: 'rtsp://x' })

    const [action, params] = broker.callSpy.mock.calls[0] as [
      string,
      { capName?: string; childId?: string; deviceId?: number },
    ]
    expect(action).toBe(AGENT_CAP_FWD_ACTION)
    expect(params.capName).toBe('pipeline-executor')
    expect(params.childId).toBe('addon-detection-pipeline')
    expect(params.deviceId).toBe(7)
  })
})
