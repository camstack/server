/**
 * Test helpers for the orchestrator E2E scenarios.
 *
 * Provides:
 *  - `makeFakeContext`: a minimal `AddonContext` stub with working
 *    `settings` (in-memory store), `eventBus` (local pub/sub), `logger`
 *    (silent), and `registerProvider`.
 *    Accepts an optional `FakeBroker` (via `addonConfig.moleculerBroker`
 *    back-compat shim) to wire `ctx.api.pipelineRunner.*` calls through
 *    the broker's handler map without any Moleculer transport.
 *  - `makeFakeBroker`: a stub that routes `broker.call` to handlers
 *    registered under `{nodeID → {action → handler}}`. After connecting
 *    an eventBus (done automatically by `makeFakeContext`), `addNode` /
 *    `removeNode` emit `AgentOnline` / `AgentOffline` events so the
 *    orchestrator's eventBus subscriptions fire correctly.
 *  - `waitUntil`: same polling helper as the kernel cluster tests.
 *
 * These helpers avoid spinning up real Moleculer brokers + transporters.
 * Fast (~20ms per test), deterministic, no transport flakiness.
 */
import type {
  AudioAttachDeviceInput,
  AddonContext,
  IEventBus,
  SystemEvent,
  IScopedLogger,
  EventFilter,
  IPipelineRunnerProvider,
  RunnerCameraConfig,
  RunnerLocalLoad,
  RunnerLocalMetrics,
  CameraMetrics,
  IStreamBroker,
  DecodedAudioChunk,
  IAudioAnalyzer,
  AudioAnalysisResult,
  AudioAnalysisSettings,
  AudioChunkInput,
  IDevice,
  ICameraDevice,
  StreamSourceEntry,
  IDeviceRegistryReader,
  IAnalysisAddon,
  AnalysisFrameOutput,
  FrameInput,
  FrameResult,
  DetectionEvent,
  PipelineStatus,
  MotionSource,
  KnownFace,
  KnownPlate,
  CameraLiveState,
  TrackedObjectSummary,
  ZoneLiveState,
  TrackDetail,
  TrackFilter,
  ZoneHistoryPoint,
  HeatmapData,
  HeatmapOptions,
  TimeRangeOptions,
} from '@camstack/types'
import {
  AudioAnalysisSettingsSchema,
  DeviceType,
  EventCategory,
  createEvent,
  readNodePin,
} from '@camstack/types'
import { makeFakeSettingsStore } from './fake-settings-store.js'
import { makeFakeRecords } from './fake-records.js'
import { CameraSensorsController } from '../camera-sensors/controller.js'
import { CameraSensorsSource } from '../camera-sensors/source.js'
import { CameraMotionSlice } from '../camera-sensors/motion-slice.js'

/**
 * A camera-sensors controller that watches nothing and never reads: for tests
 * that wire `wireOrchestratorSubscriptions` by hand and are not about D672.
 * Real classes, not a stub, so the teardown's `stop()` runs for real.
 */
export function makeIdleCameraSensors(logger: IScopedLogger): CameraSensorsController {
  const unreadable = async () => ({ kind: 'unreadable', error: 'idle test double' }) as const
  return new CameraSensorsController({
    logger,
    source: new CameraSensorsSource({
      logger,
      emitMotion: () => undefined,
      motionSourcesFor: () => null,
      sustainMsFor: () => 15_000,
      cooldownMsFor: () => 30_000,
      maxHoldMsFor: () => 120_000,
      now: () => Date.now(),
    }),
    listCameraIds: unreadable,
    readSetting: async () => ({ state: 'not-configured' }),
    ports: { logger, listByAddon: unreadable, listByIds: unreadable, sourceCapsOf: unreadable },
  })
}

/** A motion-slice writer whose gate never opens (D696): it writes nothing. */
export function makeIdleMotionSlice(logger: IScopedLogger): CameraMotionSlice {
  return new CameraMotionSlice({
    logger,
    writeSlice: async () => undefined,
    readSlice: async () => ({ kind: 'unreadable', error: 'idle test double' }),
    listCameraIds: async () => ({ kind: 'unreadable', error: 'idle test double' }),
    motionSourcesFor: () => null,
    windowMsFor: () => 30_000,
    maxHoldMsFor: () => 120_000,
    now: () => Date.now(),
    onEdgeWhileClosed: () => undefined,
    isCameraOpen: () => false,
  })
}

// ── waitUntil (polling helper) ─────────────────────────────────────────

export async function waitUntil(
  condition: () => boolean,
  timeout = 1000,
  interval = 10,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitUntil timed out after ${timeout}ms`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

// ── Fake broker ───────────────────────────────────────────────────────

export type NodeId = string
export type Action = string
export type BrokerHandler = (input: unknown) => unknown | Promise<unknown>

export interface FakeBroker {
  readonly nodeID: NodeId
  /** { nodeId → { action → handler } } */
  readonly handlers: Map<NodeId, Map<Action, BrokerHandler>>
  /** Registered service names per node, for `registry.getNodeList`. */
  readonly services: Map<NodeId, Set<string>>
  /** @deprecated — kept for direct assertions in broker unit tests only. */
  readonly busListeners: Map<string, Set<(data: { node: { id: string } }) => void>>

  call<T = unknown>(
    action: string,
    input?: unknown,
    opts?: { readonly nodeID?: string; readonly timeout?: number },
  ): Promise<T>

  readonly registry: {
    getNodeList(opts: { onlyAvailable: boolean; withServices?: boolean }): Array<{
      readonly id: string
      readonly services?: ReadonlyArray<{ readonly name: string }>
    }>
  }

  readonly localBus: {
    on(event: string, handler: (data: { node: { id: string } }) => void): void
    off(event: string, handler: (data: { node: { id: string } }) => void): void
  }

  // Test-facing helpers
  registerAction(nodeId: NodeId, action: Action, handler: BrokerHandler): void
  registerService(nodeId: NodeId, serviceName: string): void
  removeNode(nodeId: NodeId): void
  addNode(nodeId: NodeId): void
  /**
   * Connect an IEventBus so that `addNode` / `removeNode` fire
   * `AgentOnline` / `AgentOffline` events in addition to the legacy
   * `localBus` callbacks. Called automatically by `makeFakeContext`.
   */
  connectEventBus(bus: IEventBus): void
}

export function makeFakeBroker(localNodeId: NodeId): FakeBroker {
  const handlers = new Map<NodeId, Map<Action, BrokerHandler>>()
  const services = new Map<NodeId, Set<string>>()
  const busListeners = new Map<string, Set<(data: { node: { id: string } }) => void>>()
  let eventBus: IEventBus | null = null

  // Seed the local node entry so `getNodeList` shows it.
  handlers.set(localNodeId, new Map())
  services.set(localNodeId, new Set())

  const broker: FakeBroker = {
    nodeID: localNodeId,
    handlers,
    services,
    busListeners,

    async call<T>(
      action: string,
      input?: unknown,
      opts?: { readonly nodeID?: string; readonly timeout?: number },
    ): Promise<T> {
      const targetNodeId = opts?.nodeID ?? localNodeId
      const nodeHandlers = handlers.get(targetNodeId)
      if (!nodeHandlers) throw new Error(`Node "${targetNodeId}" is offline`)
      const handler = nodeHandlers.get(action)
      if (!handler) throw new Error(`Action "${action}" not registered on node "${targetNodeId}"`)
      return (await handler(input)) as T
    },

    registry: {
      getNodeList(opts: { onlyAvailable: boolean; withServices?: boolean }) {
        const out: Array<{ id: string; services?: ReadonlyArray<{ name: string }> }> = []
        for (const id of handlers.keys()) {
          const nodeServices = services.get(id)
          const list = nodeServices ? [...nodeServices].map((name) => ({ name })) : []
          out.push(opts.withServices ? { id, services: list } : { id })
        }
        return out
      },
    },

    localBus: {
      on(event, handler) {
        const set = busListeners.get(event) ?? new Set()
        set.add(handler)
        busListeners.set(event, set)
      },
      off(event, handler) {
        busListeners.get(event)?.delete(handler)
      },
    },

    registerAction(nodeId, action, handler) {
      let nodeHandlers = handlers.get(nodeId)
      if (!nodeHandlers) {
        nodeHandlers = new Map()
        handlers.set(nodeId, nodeHandlers)
        services.set(nodeId, new Set())
      }
      nodeHandlers.set(action, handler)
    },

    registerService(nodeId, serviceName) {
      let nodeServices = services.get(nodeId)
      if (!nodeServices) {
        nodeServices = new Set()
        services.set(nodeId, nodeServices)
        handlers.set(nodeId, new Map())
      }
      nodeServices.add(serviceName)
    },

    removeNode(nodeId) {
      handlers.delete(nodeId)
      services.delete(nodeId)
      // Legacy localBus listeners (kept for broker unit tests)
      for (const listener of busListeners.get('$node.disconnected') ?? []) {
        listener({ node: { id: nodeId } })
      }
      // EventBus AgentOffline — picked up by the orchestrator
      eventBus?.emit(
        createEvent(
          EventCategory.AgentOffline,
          { type: 'system', id: nodeId, nodeId },
          { agentId: nodeId },
        ),
      )
    },

    addNode(nodeId) {
      if (!handlers.has(nodeId)) handlers.set(nodeId, new Map())
      if (!services.has(nodeId)) services.set(nodeId, new Set())
      // Legacy localBus listeners (kept for broker unit tests)
      for (const listener of busListeners.get('$node.connected') ?? []) {
        listener({ node: { id: nodeId } })
      }
      // EventBus AgentOnline — picked up by the orchestrator
      eventBus?.emit(
        createEvent(
          EventCategory.AgentOnline,
          { type: 'system', id: nodeId, nodeId },
          { agentId: nodeId },
        ),
      )
    },

    connectEventBus(bus: IEventBus) {
      eventBus = bus
    },
  }

  return broker
}

// ── Fake AddonContext ─────────────────────────────────────────────────

/** One `deviceState` call's address (and the slice, on a write). */
interface FakeSliceAddress {
  readonly deviceId: number
  readonly capName: string
  readonly slice: unknown
}

export interface FakeSettingsStore {
  global: Record<string, unknown>
  devices: Map<number, Record<string, unknown>>
  /** Per-device runtime-state blobs (cap-keyed slices). Backs the
   *  unified `device-state.setCapSlice` write path; in tests this is
   *  pure in-memory. */
  deviceRuntimeStates: Map<number, Record<string, unknown>>
}

export function makeSilentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export function makeLocalEventBus(): {
  bus: IEventBus
  captured: SystemEvent[]
} {
  const captured: SystemEvent[] = []
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()

  const matches = (pattern: string, category: string): boolean => {
    if (pattern === '*' || pattern === '**') return true
    if (pattern.endsWith('.**')) return category.startsWith(pattern.slice(0, -3))
    if (pattern.endsWith('.*')) return category.startsWith(pattern.slice(0, -2))
    return pattern === category
  }

  const extractPattern = (filter: EventFilter | string): string => {
    if (typeof filter === 'string') return filter
    if (filter && typeof filter === 'object' && 'category' in filter) {
      const cat = filter.category
      if (typeof cat === 'string') return cat
      if (Array.isArray(cat) && cat.length > 0) return String(cat[0])
    }
    return '*'
  }

  const bus: IEventBus = {
    emit(event: SystemEvent) {
      captured.push(event)
      for (const [pattern, set] of handlers) {
        if (matches(pattern, event.category)) {
          for (const h of set) h(event)
        }
      }
    },
    subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void) {
      const pattern = extractPattern(filter)
      const existing = handlers.get(pattern)
      if (existing) existing.add(handler)
      else handlers.set(pattern, new Set([handler]))
      return () => {
        handlers.get(pattern)?.delete(handler)
      }
    },
    getRecent() {
      return captured as readonly SystemEvent[]
    },
  }

  return { bus, captured }
}

/**
 * `[TEST-HARNESS-EXPLICIT]` — enumerate the node ids currently live on a
 * fake broker. Tests use this to seed `initialGlobalSettings.enabledNodes`
 * explicitly, replacing the implicit auto-populate that used to live
 * inside `readAddonStore`.
 *
 * The `hub` node is always prepended — it's the default the orchestrator
 * schema ships with, and every test that spins up remote runners still
 * wants the hub itself to be eligible for dispatch.
 */
export function enabledNodesFromBroker(broker: unknown): string[] {
  const brokerLike = broker as
    | {
        registry?: {
          getNodeList?: (opts: {
            onlyAvailable: boolean
            withServices?: boolean
          }) => Array<{ id: string }>
        }
      }
    | undefined
  const nodes = brokerLike?.registry?.getNodeList?.({ onlyAvailable: true }) ?? []
  const ids = nodes.map((n) => n.id).filter((id): id is string => typeof id === 'string')
  return [...new Set(['hub', ...ids])]
}

/**
 * `[TEST-HARNESS-ADAPTER]` — translate the legacy per-concern enable lists
 * (`enabledNodes` / `enabledDecoderNodes` / `enabledAudioNodes`) that tests
 * seed via `initialGlobalSettings` into the per-node capability store
 * (`agentSettings[node].{detect,decode,audio}`) that replaced them in the
 * placement-model redesign. The orchestrator now derives its enabled-node
 * sets from that store, so this keeps the readable list-based seeds working
 * without leaking the storage shape into every test.
 *
 * For each list that is present, EVERY node referenced across the three lists
 * (plus `hub`) gets an explicit boolean for that concern (`list.includes(node)`),
 * so exclusions (e.g. a node in decode but not detect) are faithfully modeled.
 * Any explicit `agentSettings` seed is preserved and the capability flags are
 * merged on top. The legacy list keys are left in place (harmless — the
 * orchestrator ignores them now).
 */
export function translateEnableListsToCapabilities(
  global: Record<string, unknown>,
): Record<string, unknown> {
  const asList = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  const detectList = asList(global['enabledNodes'])
  const decodeList = asList(global['enabledDecoderNodes'])
  const audioList = asList(global['enabledAudioNodes'])
  if (!detectList && !decodeList && !audioList) return global

  const referenced = new Set<string>(['hub'])
  for (const list of [detectList, decodeList, audioList]) {
    for (const id of list ?? []) referenced.add(id)
  }

  const existing = (global['agentSettings'] ?? {}) as Record<string, Record<string, unknown>>
  const agentSettings: Record<string, Record<string, unknown>> = {}
  for (const nodeId of referenced) {
    const base = existing[nodeId] ?? { maxCameras: null }
    agentSettings[nodeId] = {
      ...base,
      ...(detectList ? { detect: detectList.includes(nodeId) } : {}),
      ...(decodeList ? { decode: decodeList.includes(nodeId) } : {}),
      ...(audioList ? { audio: audioList.includes(nodeId) } : {}),
    }
  }
  // Preserve any explicitly-seeded agent entries not referenced by a list.
  for (const [nodeId, entry] of Object.entries(existing)) {
    if (!(nodeId in agentSettings)) agentSettings[nodeId] = entry
  }
  return { ...global, agentSettings }
}

export interface FakeContextOptions {
  readonly addonId?: string
  /**
   * Back-compat shim: pass `{ moleculerBroker: broker }` here and
   * `makeFakeContext` will wire `ctx.api.pipelineRunner.*` through the
   * broker's handler map and connect the broker's `addNode`/`removeNode`
   * to the eventBus so `AgentOnline`/`AgentOffline` events fire.
   */
  readonly addonConfig?: Record<string, unknown>
  readonly initialGlobalSettings?: Record<string, unknown>
  readonly initialDeviceSettings?: Map<number, Record<string, unknown>>
  /**
   * Seed the in-process capability registry with providers — simulates
   * `ctx.registerProvider` calls that would normally be made by other
   * addons loaded before this one (`stream-broker`, `audio-analyzer`,
   * `analysis-pipeline`, `pipeline-runner`, …).
   */
  readonly providers?: Record<string, unknown>
  /**
   * Seed the map consulted by `ctx.getNativeProvider(cap, deviceId)`.
   * Keyed as `${capName}:${deviceId}`. Tests that exercise native-cap
   * lookups populate this; tests that don't leave it empty and the
   * stub throws with a clear error if the orchestrator ever hits it.
   */
  readonly nativeProviders?: Map<string, unknown>
  /**
   * Seed the map consulted by `ctx.fetchDevice(deviceId)`. Each entry
   * is the fully-resolved device proxy the caller would receive.
   */
  readonly devices?: Map<number, unknown>
  /**
   * Override the default silent logger — lets a test assert on
   * `warn`/`info` call args (e.g. Gate B's attach-time surfacing) without
   * a cast past `AddonContext.logger`'s `readonly` modifier.
   */
  readonly logger?: IScopedLogger
  /**
   * Devices the DEVICE REGISTRY no longer has — `deviceManager.getDevice`
   * answers `null` for them and `listAll` omits them, exactly as it does for a
   * camera the operator deleted.
   *
   * Deliberately a live `Set` the test keeps a handle on: deletion is a
   * mid-test event (dispatch a camera, then delete it), and the broker's
   * profile slots deliberately OUTLIVE the deletion — that gap is the whole
   * subject of `device-deletion-resurrection.spec.ts`.
   */
  readonly deletedDeviceIds?: Set<number>
  /**
   * Vendor onboard-AI FORWARDING flag per device — backs
   * `ctx.api.nativeObjectDetection.getStatus`/`.setEnabled`. Deliberately a
   * live `Map` the test keeps a handle on: the whole subject of the
   * onboard-forwarding reconcile is whether the orchestrator MOVED this flag,
   * so the test reads it back after the attach.
   *
   * A device absent from the map has no flag to read and `getStatus` throws —
   * which is what a cap that could not answer looks like, and it must never
   * read as `false`.
   */
  readonly onboardForwarding?: Map<number, boolean>
  /**
   * Make `nativeObjectDetection.getStatus` fail for these devices even though
   * the binding exists — the "the flag could not be read" branch.
   */
  readonly onboardForwardingReadFails?: Set<number>
  /**
   * Non-camera devices a camera can have ATTACHED as sensors (D672). Listed by
   * `deviceManager.listAll` (honouring its `addonId` / `deviceIds` /
   * `isCamera` filters — for these rows only; camera rows stay unfiltered as
   * before) and answered by `getBindingsBatch` with their `capNames`. Absent,
   * the fake is exactly what it was: no sensor rows, no `getBindingsBatch`.
   */
  readonly sensorDevices?: readonly FakeSensorDevice[]
  /**
   * Live override of a sensor's bound caps, keyed by device id — a provider
   * retracting (`[]`) and re-registering its bindings mid-test. Absent for a
   * device, `getBindingsBatch` answers its `capNames`.
   */
  readonly sensorBoundCaps?: Map<number, readonly string[]>
  /**
   * The hub registry's node list (`nodes.directory`). Absent, the fake has no
   * `nodes` cap and the read fails — which the motion-slice gate treats as
   * unanswered (D696).
   */
  readonly nodeDirectory?: readonly FakeDirectoryNode[]
  /**
   * The addon that owns each camera, as `deviceManager.listAll` reports it
   * (default `test`). A camera of a provider that wrote the `motion` slice
   * before D696 is gated on that provider's answer (D696 amended).
   */
  readonly cameraOwners?: ReadonlyMap<number, string>
  /**
   * `deviceProvider.getStatus({ addonId })` per provider: `'orchestrator'`
   * answers the field (a provider that no longer writes the slice), `null`
   * answers without it (an OLD provider). A provider absent from the map does
   * not answer (the read throws). A live `Map`: a provider is upgraded or rolled
   * back mid-test.
   */
  readonly providerSliceWriters?: Map<string, 'orchestrator' | null>
}

/** One `nodes.directory` row. */
export interface FakeDirectoryNode {
  readonly id: string
  readonly isOnline: boolean
}

/** One attachable sensor device in the fake registry (D672). */
export interface FakeSensorDevice {
  readonly id: number
  readonly addonId: string
  readonly stableId: string
  readonly capNames: readonly string[]
  /** The registry name; `sensor-<id>` when absent. */
  readonly name?: string
}

/** The `listAll` filters the fake honours for sensor rows. */
interface FakeListAllFilter {
  readonly addonId?: string
  readonly isCamera?: boolean
  readonly deviceIds?: readonly number[]
}

export function makeFakeContext(opts: FakeContextOptions = {}): {
  ctx: AddonContext
  store: FakeSettingsStore
  eventBus: IEventBus
  captured: SystemEvent[]
  registeredProviders: Map<string, unknown>
} {
  const store: FakeSettingsStore = {
    global: translateEnableListsToCapabilities({ ...opts.initialGlobalSettings }),
    devices: new Map(opts.initialDeviceSettings ?? []),
    deviceRuntimeStates: new Map(),
  }

  const { bus, captured } = makeLocalEventBus()
  const registeredProviders = new Map<string, unknown>(Object.entries(opts.providers ?? {}))

  // Back-compat shim: older tests pass the fake broker via
  // `addonConfig.moleculerBroker`. Wire it as `ctx.api.pipelineRunner.*`
  // (routing through `broker.call`) and connect it to the eventBus so
  // `addNode`/`removeNode` emit `AgentOnline`/`AgentOffline`.
  const fakeBroker = (opts.addonConfig as { moleculerBroker?: unknown } | undefined)
    ?.moleculerBroker as FakeBroker | undefined
  if (fakeBroker && typeof fakeBroker.connectEventBus === 'function') {
    fakeBroker.connectEventBus(bus)
  }

  // Build a fake ctx.api.pipelineRunner namespace that routes calls
  // through the broker's handler map (same action names as before).
  // Shaped as a tRPC procedure proxy — `{ query(input), mutate(input) }` —
  // to match the real client shape the orchestrator dispatches through
  // (`callPipelineRunner` picks `.query`/`.mutate` by cap-def kind).
  const makePipelineRunnerMethod = (action: string) => {
    const call = (input: unknown): Promise<unknown> => {
      if (!fakeBroker)
        return Promise.reject(new Error(`No fake broker — cannot call pipelineRunner.${action}`))
      const nodeId = ((input as Record<string, unknown>)?.['nodeId'] as string) ?? fakeBroker.nodeID
      return fakeBroker.call(`pipeline-runner.pipeline-runner.${action}`, input, { nodeID: nodeId })
    }
    return { query: call, mutate: call }
  }

  // `getLocalCameras` is the one `pipelineRunner` call the orchestrator
  // node-pins via the SECOND `.query(input, opts)` arg (`nodePin(nodeId)`,
  // Task 3 / `reconcilePlacementFromRunners`) rather than embedding the
  // target node in the input payload — mirror that routing convention here
  // instead of reusing `makePipelineRunnerMethod` (which only ever reads
  // `input.nodeId`).
  const makePipelineRunnerNodePinnedMethod = (action: string) => {
    const call = (input: unknown, opts?: unknown): Promise<unknown> => {
      if (!fakeBroker)
        return Promise.reject(new Error(`No fake broker — cannot call pipelineRunner.${action}`))
      const context =
        opts !== null && typeof opts === 'object' ? Reflect.get(opts, 'context') : undefined
      const nodeId = readNodePin(context) ?? fakeBroker.nodeID
      return fakeBroker.call(`pipeline-runner.pipeline-runner.${action}`, input, { nodeID: nodeId })
    }
    return { query: call, mutate: call }
  }

  // Resolve providers for API namespace mocks. The orchestrator accesses
  // stream-broker, audio-analyzer, audio-classifier, analysis-pipeline,
  // and notification-output via ctx.api.X.method.query/mutate(). We build
  // tRPC-shaped namespace objects that resolve lazily from the
  // registeredProviders map so late-registered providers (post-init)
  // are visible.
  const analysisProv = registeredProviders.get('analysis-pipeline') as
    | Record<string, (...args: unknown[]) => unknown>
    | undefined
  const notifProv = registeredProviders.get('notification-output') as
    | Record<string, (...args: unknown[]) => unknown>
    | undefined

  /**
   * Narrow a `leaf`'s opaque input to the attach shape. `leaf` is deliberately
   * `unknown`-in (it stands for the whole tRPC surface), so the two D461 audio
   * leaves need a guard rather than a cast — a cast would let the orchestrator
   * send the wrong shape and the fake would still "pass".
   */
  const asAttachInput = (input: unknown): AudioAttachDeviceInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('attachDevice called with a non-object input')
    }
    const record: Record<string, unknown> = { ...input }
    const { deviceId, brokerId, ingestNodeId, settings } = record
    if (
      typeof deviceId !== 'number' ||
      typeof brokerId !== 'string' ||
      typeof ingestNodeId !== 'string' ||
      typeof settings !== 'object' ||
      settings === null
    ) {
      throw new Error(`attachDevice called with an incomplete input: ${JSON.stringify(record)}`)
    }
    return {
      deviceId,
      brokerId,
      ingestNodeId,
      settings: AudioAnalysisSettingsSchema.parse(settings),
    }
  }

  /** Same, for the one field `detachDevice` carries. */
  const readDeviceId = (input: unknown): number => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('detachDevice called with a non-object input')
    }
    const deviceId: unknown = Reflect.get(input, 'deviceId')
    if (typeof deviceId !== 'number') {
      throw new Error('detachDevice called without a numeric deviceId')
    }
    return deviceId
  }

  /** Wrap a sync/async function as a tRPC-shaped leaf: `{ query(input), mutate(input) }`. */
  const leaf = (fn: (input: unknown) => unknown) => ({
    query: (input: unknown) => Promise.resolve(fn(input)),
    mutate: (input: unknown) => Promise.resolve(fn(input)),
  })

  const fakeApi: Record<string, unknown> = {}

  // settingsStore — the declared-collection door. The orchestrator's durable
  // stores (`node-stress-move-ledger.ts`, the device-features mirror) reach
  // for it during bootstrap, so every fake context needs one; without it the
  // whole e2e suite fails at `declare`. It is a real in-memory backend, not a
  // no-op: a test that reads a row it never wrote still gets nothing.
  fakeApi.settingsStore = makeFakeSettingsStore().client

  fakeApi.deviceHistory = {
    declareSeries: leaf((input: unknown) => {
      const name =
        typeof input === 'object' &&
        input !== null &&
        'name' in input &&
        typeof input.name === 'string'
          ? input.name
          : undefined
      return {
        key: name ? `addon:pipeline-orchestrator/${name}` : 'addon:pipeline-orchestrator/test',
      }
    }),
    record: leaf(() => ({ accepted: 0, refused: [] })),
    recordBuckets: leaf(() => ({ accepted: 0, refused: [] })),
    query: leaf(() => ({ resolution: '5m', series: [], truncated: false })),
    queryNode: leaf(() => ({ resolution: '5m', series: [], truncated: false })),
    queryMany: leaf(() => ({ results: [] })),
    listSeries: leaf(() => []),
    listNodeSeries: leaf(() => []),
    getDeviceEnabled: leaf(() => ({ enabled: true })),
    setDeviceEnabled: leaf(() => ({ enabled: true })),
    getStatus: leaf(() => ({
      startedAt: 0,
      ready: true,
      series: 0,
      metrics: 0,
      optedOutDevices: 0,
      tiers: [],
      capture: {
        eventsSeen: 0,
        pointsEmitted: 0,
        pointsWritten: 0,
        pointsDropped: 0,
        bufferDepth: 0,
        trailingEmitted: 0,
        reconciledPoints: 0,
        reconcileRuns: 0,
        reconcileFailures: 0,
        lastReconcileAt: null,
        lastFlushAt: null,
        flushFailures: 0,
        skipped: {},
      },
      ingest: { accepted: 0, refused: {} },
      rollup: {
        last5mAt: null,
        last1hAt: null,
        last1dAt: null,
        errors: 0,
        dirty5m: 0,
        dirty1h: 0,
        dirty1d: 0,
      },
      retention: { lastRunAt: null, deleted: {}, purgedSeries: 0 },
      directory: { devices: 0, lastRefreshAt: null },
    })),
  }

  // customModelRegistry — the D725 stored-pin reset asks it which ids are
  // registered custom models. Delegates to a `custom-model-registry` provider's
  // `listModels()` (which may throw, to fake an unreadable registry); the
  // default answers that no custom model is registered.
  fakeApi.customModelRegistry = {
    listModels: leaf(() => {
      const cap = registeredProviders.get('custom-model-registry') as
        | { readonly listModels?: () => unknown }
        | undefined
      return cap?.listModels ? cap.listModels() : []
    }),
  }

  // pipelineRunner — routed through the fake Moleculer broker
  if (fakeBroker) {
    fakeApi.pipelineRunner = {
      attachCamera: makePipelineRunnerMethod('attachCamera'),
      detachCamera: makePipelineRunnerMethod('detachCamera'),
      getLocalLoad: makePipelineRunnerMethod('getLocalLoad'),
      reportMotion: makePipelineRunnerMethod('reportMotion'),
      getLocalCameras: makePipelineRunnerNodePinnedMethod('getLocalCameras'),
      startNodeBench: makePipelineRunnerNodePinnedMethod('startNodeBench'),
      getNodeBenchStatus: makePipelineRunnerNodePinnedMethod('getNodeBenchStatus'),
      abortNodeBench: makePipelineRunnerNodePinnedMethod('abortNodeBench'),
    }
  }

  // pipelineExecutor — minimal stub. The orchestrator's device-settings
  // contribution calls `getSchema` to embed the per-camera addon
  // catalog in the `pipeline-editor` ConfigField; tests that don't
  // care about pipeline-editor rendering get a shaped empty catalog
  // so the contribution path still succeeds. Tests that DO assert on
  // the catalog can pass a richer fixture via `opts.providers`.
  const executorStub = registeredProviders.get('pipeline-executor') as
    | {
        readonly getSchema?: (input: { nodeId: string }) => unknown
        /** Pool health (`unhealthy` device keys); absent ⇒ every pool healthy. */
        readonly getInferenceDeviceHealth?: (input: { nodeId: string }) => unknown
        /**
         * Task G5 (Gate B). `opts` is the second `.query(input, opts)` arg
         * the orchestrator's `attachOn` passes — carries `nodePin(nodeId)`.
         * Exposed to the stub so a test can assert on it (e.g. via a
         * capturing wrapper) without the fake harness modeling real
         * cross-node routing.
         */
        readonly validatePipeline?: (
          input: { readonly steps: readonly unknown[] },
          opts?: unknown,
        ) => unknown
      }
    | undefined
  fakeApi.pipelineExecutor = {
    // Camera-status detection stage. Same story as `getBrokerStats`: absent
    // until a spec called `getCameraStatus` for an ATTACHED camera, and the
    // absence surfaced as an unhandled rejection rather than a null stage.
    getEngineProvisioning: leaf(() => ({ state: 'ready' as const })),
    getSelectedEngine: leaf(() => ({ runtime: 'python', backend: 'cpu', format: 'onnx' })),
    getSchema: leaf((input) => {
      if (executorStub?.getSchema) return executorStub.getSchema(input as { nodeId: string })
      return {
        slots: [],
        availableEngines: [],
        selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
      }
    }),
    // Not wrapped via `leaf()` — that helper drops every arg past the
    // first, but Gate B's node-pinning contract is carried in the SECOND
    // `.query(input, opts)` arg (`nodePin(nodeId)`), which tests need to
    // observe. Default (no stub registered): a clean, non-blocking result.
    validatePipeline: {
      // Declared `async` (not a plain arrow returning `Promise.resolve(fn())`)
      // so a stub that THROWS synchronously still surfaces as a rejected
      // promise — matching how a real tRPC client's `.query()` behaves (it
      // is itself an async function; a handler throw never escapes
      // synchronously). Without this, `attachOn`'s `.catch(() => null)`
      // would never run for a throwing stub, which is a harness-fidelity
      // gap, not a real production behavior.
      query: async (input: unknown, opts?: unknown) => {
        if (executorStub?.validatePipeline) {
          return executorStub.validatePipeline(input as { steps: readonly unknown[] }, opts)
        }
        return { ok: true, issues: [], substitutions: [], format: 'onnx' }
      },
    },
    getInferenceDeviceHealth: leaf((input) => {
      if (executorStub?.getInferenceDeviceHealth) {
        return executorStub.getInferenceDeviceHealth(input as { nodeId: string })
      }
      return { unhealthy: [] }
    }),
  }

  // platformProbe — live inference-device probe used by the orchestrator's
  // per-device balancer (multi-device C4 / orch-F5). Delegates to a
  // `platform-probe` provider's `getCapabilities({ nodeId? })` when registered;
  // the default returns an EMPTY device set (no eligible accelerators) so a test
  // that doesn't opt into multi-device sees the single-default behaviour and no
  // `deviceKey` is set on attach.
  const probeStub = registeredProviders.get('platform-probe') as
    | { readonly getCapabilities?: (input?: { readonly nodeId?: string }) => unknown }
    | undefined
  fakeApi.platformProbe = {
    getCapabilities: leaf((input) => {
      if (probeStub?.getCapabilities) {
        return probeStub.getCapabilities(input as { nodeId?: string } | undefined)
      }
      return { nodeId: 'hub', reachable: true, devices: [] }
    }),
  }

  // streamBroker — delegates to the FakeStreamBrokerCap from providers map.
  // Resolved lazily so late-registered providers (post-init) are visible.
  fakeApi.streamBroker = {
    listAllProfileSlots: leaf(() => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) return []
      return cap.listAllProfileSlots()
    }),
    subscribeAudioChunks: leaf((input) => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) throw new Error('fake stream-broker cap not registered')
      return cap.subscribeAudioChunks(input as { brokerId: string; tag?: string })
    }),
    pullAudioChunks: leaf((input) => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) return []
      return cap.pullAudioChunks(input as { subscriptionId: string; maxCount: number })
    }),
    unsubscribeAudioChunks: leaf((input) => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) return { released: false }
      return cap.unsubscribeAudioChunks(input as { subscriptionId: string })
    }),
    // The camera-status aggregator's broker stage. Absent until now because
    // no spec in this harness called `getCameraStatus`; its absence surfaced
    // as an UNHANDLED rejection (the stage's `.catch` is attached one line
    // after the throwing property access), which reads as an unrelated crash.
    getBrokerStats: leaf(() => ({
      brokerId: '',
      running: false,
      subscribers: 0,
      bytesOut: 0,
      uptimeSec: 0,
    })),
    listClients: leaf(() => ({ rtsp: [], webrtc: [], audio: [] })),
    // D83 broker-side audio mute. A cap that is not registered answers
    // NOTHING — the switch service must render `source-unreachable` for it,
    // never a control defaulted to "audio flows", so the fake throws rather
    // than returning a comfortable default.
    getDeviceAudioMute: leaf((input) => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) throw new Error('fake stream-broker cap not registered')
      return cap.getDeviceAudioMute(input as { deviceId: number })
    }),
    setDeviceAudioMute: leaf((input) => {
      const cap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
      if (!cap) throw new Error('fake stream-broker cap not registered')
      return cap.setDeviceAudioMute(input as { deviceId: number; muted: boolean })
    }),
  }

  // audioAnalyzer (system, compute) + audioAnalysis (device, per-device surface)
  // — both back onto the same FakeAudioAnalyzer registered under either cap name.
  const resolveAudioProv = () => {
    const viaAnalyzer = registeredProviders.get('audio-analyzer') as FakeAudioAnalyzer | undefined
    if (viaAnalyzer) return viaAnalyzer
    return registeredProviders.get('audio-analysis') as FakeAudioAnalyzer | undefined
  }
  fakeApi.audioAnalyzer = {
    analyseChunk: leaf((input) => {
      const prov = resolveAudioProv()
      return prov ? prov.analyseChunk(input as never) : null
    }),
    // D461: the orchestrator no longer pushes chunks — it asks the analyzer to
    // PULL this camera's audio and to stop. Both are dispatched through this
    // namespace, so they have to exist here as well as on the provider, or the
    // orchestrator's audio path dies on `undefined.mutate` with no subscription
    // and no line saying why.
    attachDevice: leaf((input) => {
      const prov = resolveAudioProv()
      if (!prov) return { attached: false, replaced: false }
      return prov.attachDevice(asAttachInput(input))
    }),
    detachDevice: leaf((input) => {
      const prov = resolveAudioProv()
      if (!prov) return { detached: false }
      return prov.detachDevice({ deviceId: readDeviceId(input) })
    }),
    classify: leaf(() => ({ labels: [], rawLabels: [], inferenceMs: 0 })),
    isReady: leaf(() => resolveAudioProv() != null),
    dispose: leaf(() => undefined),
  }
  fakeApi.audioAnalysis = {
    resolveDeviceSettings: leaf((input) => {
      const prov = resolveAudioProv()
      return prov ? prov.resolveDeviceSettings(input as never) : null
    }),
  }

  // audioClassifier — simple stub, orchestrator only checks isReady
  fakeApi.audioClassifier = {
    isReady: leaf(() => true),
  }

  // recording-archive — the per-camera `RecordingConfig`, the authority behind
  // the `recording` function switch. It stayed a system SINGLETON when
  // `recording` became a device collection (D625) precisely so one reader and
  // one writer decide when a camera records. Held whole so a test can assert
  // that flipping the switch left `bands` byte-identical.
  const recordingConfigs = new Map<number, { enabled: boolean; bands: unknown[] }>()
  fakeApi.recordingArchive = {
    // Auto-injected by codegen from the cap's `status` schema — the camera
    // status aggregator's recording stage calls it.
    getStatus: leaf((input: unknown) => {
      const { deviceId } = input as { deviceId: number }
      const config = recordingConfigs.get(deviceId) ?? { enabled: false, bands: [] }
      return {
        activeMode: config.enabled && config.bands.length > 0 ? 'continuous' : 'off',
        enabled: config.enabled,
        storageBytes: 0,
      }
    }),
    getDeviceConfig: leaf((input: unknown) => {
      const { deviceId } = input as { deviceId: number }
      return recordingConfigs.get(deviceId) ?? { enabled: false, bands: [] }
    }),
    setDeviceConfig: leaf((input: unknown) => {
      const { deviceId, config } = input as {
        deviceId: number
        config: { enabled: boolean; bands: unknown[] }
      }
      recordingConfigs.set(deviceId, config)
      return config
    }),
  }

  // notificationRules — the permanent per-camera mute behind the
  // `notifications` function switch.
  const mutedDevices = new Set<number>()
  fakeApi.notificationRules = {
    listDeviceMutes: leaf(() => ({ mutedDeviceIds: [...mutedDevices].toSorted((a, b) => a - b) })),
    setDeviceMuted: leaf((input: unknown) => {
      const { deviceId, muted } = input as { deviceId: number; muted: boolean }
      if (muted) mutedDevices.add(deviceId)
      else mutedDevices.delete(deviceId)
      return { success: true as const }
    }),
  }

  // native-object-detection — the vendor MECHANISM the camera's
  // `detectionSources` pick drives. The orchestrator reconciles this flag on
  // every attach, so the harness has to be able to disagree with the pick.
  const onboardForwarding = opts.onboardForwarding ?? new Map<number, boolean>()
  const onboardReadFails = opts.onboardForwardingReadFails ?? new Set<number>()
  fakeApi.nativeObjectDetection = {
    getStatus: leaf((input: unknown) => {
      const { deviceId } = input as { deviceId: number }
      if (onboardReadFails.has(deviceId)) {
        throw new Error(`test harness: native-object-detection unreachable on ${deviceId}`)
      }
      const enabled = onboardForwarding.get(deviceId)
      if (enabled === undefined) {
        throw new Error(
          `test harness: no onboard forwarding flag seeded for '${deviceId}' — ` +
            `pass FakeContextOptions.onboardForwarding`,
        )
      }
      return { lastByClass: {}, supportedClasses: ['person'], enabled }
    }),
    setEnabled: leaf((input: unknown) => {
      const { deviceId, enabled } = input as { deviceId: number; enabled: boolean }
      onboardForwarding.set(deviceId, enabled)
      return undefined
    }),
    getOptions: leaf(() => ({ supportedClasses: ['person'], geometry: 'boxed' as const })),
    setSettings: leaf((input: unknown) => {
      const { deviceId, settings } = input as {
        deviceId: number
        settings: { enabled?: boolean }
      }
      if (settings.enabled !== undefined) onboardForwarding.set(deviceId, settings.enabled)
      return undefined
    }),
  }

  // deviceManager — orchestrator consults getBindings to gate audio-analysis
  // + detection-pipeline wrappers. The harness tracks a per-device
  // disabled-cap set that `setWrapperActive({active:false})` populates, then
  // getBindings skips the corresponding entry (mirrors the production
  // flow where disabling a wrapper removes its row from getBindings).
  const disabledBindings = new Map<number, Set<string>>()
  /** Devices soft-disabled via `deviceManager.setDisabled` (the D61 camera switch). */
  const disabledDevices = new Set<number>()
  /** Devices the registry no longer has (deleted) — see `FakeContextOptions.deletedDeviceIds`. */
  const deletedDevices = opts.deletedDeviceIds ?? new Set<number>()
  /** Every device this fake cluster still has: seeded settings ∪ published slots, minus deleted. */
  const registryDeviceIds = (): ReadonlySet<number> => {
    const ids = new Set<number>(store.devices.keys())
    const brokerCap = registeredProviders.get('stream-broker') as FakeStreamBrokerCap | undefined
    for (const slot of brokerCap?.listAllProfileSlots() ?? []) ids.add(slot.deviceId)
    for (const deleted of deletedDevices) ids.delete(deleted)
    return ids
  }
  const isCapDisabled = (deviceId: number, capName: string): boolean =>
    disabledBindings.get(deviceId)?.has(capName) ?? false
  // deviceState — the hub's runtime slices, in memory, over the same
  // `deviceRuntimeStates` map the settings fake keeps. The orchestrator writes
  // a camera's `motion` slice here (D696) and reads it back on a takeover.
  const sliceOf = (input: unknown): FakeSliceAddress => {
    if (typeof input !== 'object' || input === null) throw new Error('deviceState: bad input')
    const deviceId: unknown = Reflect.get(input, 'deviceId')
    const capName: unknown = Reflect.get(input, 'capName')
    if (typeof deviceId !== 'number' || typeof capName !== 'string') {
      throw new Error('deviceState: deviceId/capName missing')
    }
    return { deviceId, capName, slice: Reflect.get(input, 'slice') }
  }
  fakeApi.deviceState = {
    getCapSlice: leaf((input) => {
      const { deviceId, capName } = sliceOf(input)
      const slice: unknown = store.deviceRuntimeStates.get(deviceId)?.[capName]
      return slice ?? null
    }),
    setCapSlice: leaf((input) => {
      const { deviceId, capName, slice } = sliceOf(input)
      store.deviceRuntimeStates.set(deviceId, {
        ...store.deviceRuntimeStates.get(deviceId),
        [capName]: slice,
      })
      return undefined
    }),
  }

  if (opts.nodeDirectory !== undefined) {
    const listed = opts.nodeDirectory
    fakeApi.nodes = {
      directory: leaf(() => ({
        nodes: listed.map((n) => ({
          id: n.id,
          name: n.id,
          isHub: n.id === 'hub',
          isOnline: n.isOnline,
        })),
        complete: true,
      })),
    }
  }

  if (opts.providerSliceWriters !== undefined) {
    const writers = opts.providerSliceWriters
    fakeApi.deviceProvider = {
      getStatus: leaf((input: unknown) => {
        const addonId =
          typeof input === 'object' && input !== null ? Reflect.get(input, 'addonId') : undefined
        if (typeof addonId !== 'string' || !writers.has(addonId)) {
          throw new Error(
            `Capability "device-provider" has no provider with addonId "${String(addonId)}"`,
          )
        }
        const writer = writers.get(addonId)
        return {
          connected: true,
          deviceCount: 1,
          ...(writer === 'orchestrator' ? { motionSliceWriter: writer } : {}),
        }
      }),
    }
  }

  fakeApi.deviceManager = {
    // listAll is consumed by the F5 migration hook and by the dispatch
    // reconcile's existence filter. Synthesize one record per device this fake
    // cluster actually has: everything with a seeded device-store entry PLUS
    // everything the fake stream-broker publishes slots for (a camera with live
    // streams is by definition in the registry) — minus what the test deleted.
    listAll: leaf((input: unknown) => {
      const filter: FakeListAllFilter =
        typeof input === 'object' && input !== null ? (input as FakeListAllFilter) : {}
      const sensorRows = (opts.sensorDevices ?? [])
        .filter(
          (d) =>
            filter.isCamera !== true &&
            (filter.addonId === undefined || filter.addonId === d.addonId) &&
            (filter.deviceIds === undefined || filter.deviceIds.includes(d.id)),
        )
        .map((d) => ({
          id: d.id,
          stableId: d.stableId,
          addonId: d.addonId,
          type: 'sensor' as const,
          name: d.name ?? `sensor-${d.id}`,
          location: null,
          disabled: false,
          parentDeviceId: null,
          online: true,
          features: [],
          isCamera: false,
          config: {},
        }))
      const cameraRows = Array.from(registryDeviceIds()).map((id) => ({
        id,
        stableId: `dev-${id}`,
        addonId: opts.cameraOwners?.get(id) ?? 'test',
        type: 'camera' as const,
        name: `camera-${id}`,
        parentDeviceId: null,
        online: true,
        features: [],
        isCamera: true,
        config: {},
      }))
      return [...cameraRows, ...sensorRows]
    }),
    getBindings: leaf((input: unknown) => {
      const { deviceId } = input as { deviceId: number }
      const entries: Array<{
        capName: string
        kind: 'native' | 'wrapped'
        providerAddonId: string
        providerNodeId: string
        nativeAddonId: string
      }> = []
      // audio-analysis is the device-scoped façade registered by the
      // audio-analyzer addon. The fake harness registers the provider
      // under the 'audio-analyzer' key, so we key off that presence.
      if (
        (registeredProviders.has('audio-analyzer') || registeredProviders.has('audio-analysis')) &&
        !isCapDisabled(deviceId, 'audio-analysis')
      ) {
        entries.push({
          capName: 'audio-analysis',
          kind: 'wrapped',
          providerAddonId: 'audio-analyzer',
          providerNodeId: 'hub',
          nativeAddonId: '',
        })
      }
      // detection-pipeline is the bindable device-scoped façade for the
      // detection-pipeline addon (registered under 'pipeline-executor').
      if (
        (registeredProviders.has('pipeline-executor') ||
          registeredProviders.has('detection-pipeline')) &&
        !isCapDisabled(deviceId, 'detection-pipeline')
      ) {
        entries.push({
          capName: 'detection-pipeline',
          kind: 'wrapped',
          providerAddonId: 'detection-pipeline',
          providerNodeId: 'hub',
          nativeAddonId: '',
        })
      }
      // Always-active bindable wrappers so the resolver reports the
      // camera as opted-in even when the fake harness registers no
      // pipeline providers — matches the defaultActive:true wrappers
      // shipped by the real addons for every camera.
      if (
        !entries.some((e) => e.capName === 'detection-pipeline') &&
        !isCapDisabled(deviceId, 'detection-pipeline')
      ) {
        entries.push({
          capName: 'detection-pipeline',
          kind: 'wrapped',
          providerAddonId: 'detection-pipeline',
          providerNodeId: 'hub',
          nativeAddonId: '',
        })
      }
      // motion-detection is defaultActive:true in production (F9 manifest
      // declaration on addon-motion-wasm). Mirror that so tests that
      // don't seed a motion-detection provider still get motion gated on
      // (F15a — motion-detection wrapper replaces the legacy
      // motionDetectionEnabled boolean as the on/off switch).
      if (!isCapDisabled(deviceId, 'motion-detection')) {
        entries.push({
          capName: 'motion-detection',
          kind: 'wrapped',
          providerAddonId: 'motion-wasm',
          providerNodeId: 'hub',
          nativeAddonId: '',
        })
      }
      if (
        registeredProviders.has('analysis-pipeline') &&
        !isCapDisabled(deviceId, 'analysis-pipeline')
      ) {
        entries.push({
          capName: 'analysis-pipeline',
          kind: 'wrapped',
          providerAddonId: 'analysis-pipeline-addon',
          providerNodeId: 'hub',
          nativeAddonId: '',
        })
      }
      // Native cap entries — synthesised from `opts.nativeProviders`
      // keyed by `${capName}:${deviceId}`. The orchestrator's
      // `deviceHasOnboardMotionCap` resolver scans `getBindings` for
      // `kind:'native'` entries to decide whether to default
      // `motionSources` to `['onboard']` instead of `['analyzer']`.
      // Without this synthesis the dynamic resolver would never see
      // the seeded provider and tests asserting onboard-motion default
      // would fail.
      for (const key of opts.nativeProviders?.keys() ?? []) {
        const [capName, idStr] = key.split(':')
        if (!capName || idStr !== String(deviceId)) continue
        if (entries.some((e) => e.capName === capName)) continue
        entries.push({
          capName,
          kind: 'native',
          providerAddonId: 'test-native',
          providerNodeId: 'hub',
          nativeAddonId: 'test-native',
        })
      }
      return { deviceId, entries }
    }),
    ...(opts.sensorDevices === undefined
      ? {}
      : {
          getBindingsBatch: leaf((input: unknown) => {
            const { deviceIds } = input as { deviceIds: readonly number[] }
            return deviceIds.map((deviceId) => ({
              deviceId,
              entries: (
                opts.sensorBoundCaps?.get(deviceId) ??
                opts.sensorDevices?.find((d) => d.id === deviceId)?.capNames ??
                []
              ).map((capName) => ({
                capName,
                kind: 'native' as const,
                providerAddonId: 'test-native',
                providerNodeId: 'hub',
                nativeAddonId: 'test-native',
              })),
            }))
          }),
        }),
    // ── Per-camera function switch group (D61) ──────────────────────
    // `getDevice` + `listBindableCapsForDeviceType` are what makes the group
    // DERIVED: the switch set comes from what a wrapper actually provides for
    // this device type, never from a hardcoded list. `disabled` is the
    // whole-device soft disable the `stream-broker` switch writes.
    getDevice: leaf((input: unknown) => {
      const { deviceId } = input as { deviceId: number }
      // A deleted device is GONE — `null`, per the cap contract. Answering a
      // record here is what a fake would do to hide a resurrection bug.
      if (deletedDevices.has(deviceId)) return null
      return {
        id: deviceId,
        stableId: `dev-${deviceId}`,
        addonId: 'test',
        type: 'camera' as const,
        name: `camera-${deviceId}`,
        parentDeviceId: null,
        online: true,
        features: [],
        isCamera: true,
        disabled: disabledDevices.has(deviceId),
        config: {},
      }
    }),
    listBindableCapsForDeviceType: leaf(() => [
      { capName: 'detection-pipeline', wrappers: ['detection-pipeline'] },
      { capName: 'audio-analysis', wrappers: ['audio-analyzer'] },
      { capName: 'motion-detection', wrappers: ['motion-wasm'] },
    ]),
    setDisabled: leaf((input: unknown) => {
      const { deviceId, disabled } = input as { deviceId: number; disabled: boolean }
      if (disabled) disabledDevices.add(deviceId)
      else disabledDevices.delete(deviceId)
      return undefined
    }),
    setWrapperActive: leaf((input: unknown) => {
      const { deviceId, capName, wrapperAddonId, active } = input as {
        deviceId: number
        capName: string
        wrapperAddonId: string
        active: boolean
      }
      const set = disabledBindings.get(deviceId) ?? new Set<string>()
      if (active) set.delete(capName)
      else set.add(capName)
      disabledBindings.set(deviceId, set)
      // Mirror production: the real device-manager emits a
      // DeviceBindingsChanged event so subscribers (orchestrator) can
      // re-dispatch. Re-implementing the emit here keeps the harness
      // behaviourally equivalent to the live hub.
      bus.emit({
        id: `bind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date(),
        source: { type: 'addon', id: 'device-manager' },
        category: EventCategory.DeviceBindingsChanged,
        data: {
          deviceId,
          capName,
          reason: active ? 'wrapper-activated' : 'wrapper-deactivated',
          addonId: wrapperAddonId,
          nodeId: 'hub',
        },
      })
      return undefined
    }),
  }

  // analysisPipeline — delegates to the provider if registered
  if (analysisProv) {
    const processFrame = analysisProv['processFrame']!
    const getCameraStatus = analysisProv['getCameraStatus']!
    fakeApi.analysisPipeline = {
      processFrame: leaf((input) => processFrame(input)),
      getCameraStatus: leaf((input) => getCameraStatus(input)),
    }
  }

  // notificationOutput — no-op capture
  if (notifProv) {
    const sendFn = notifProv['send']!
    fakeApi.notificationOutput = {
      send: leaf((input) => sendFn(input)),
      sendTest: leaf(() => undefined),
    }
  } else {
    fakeApi.notificationOutput = {
      send: leaf(() => undefined),
      sendTest: leaf(() => undefined),
    }
  }

  const ctx: AddonContext = {
    id: opts.addonId ?? 'pipeline-orchestrator',
    logger: opts.logger ?? makeSilentLogger(),
    eventBus: bus,
    addonConfig: opts.addonConfig ?? {},
    // The kinds are declared by the addon itself, in `onInitialize`.
    records: makeFakeRecords().records,
    kernel: {
      localNodeId: fakeBroker?.nodeID ?? 'hub',
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no devices')
        },
        create: async () => {
          throw new Error('no devices')
        },
        createContext: () => {
          throw new Error('no devices')
        },
        register: async () => {
          throw new Error('no devices')
        },
        remove: async () => {
          /* no-op */
        },
        decommission: async () => {
          /* no-op */
        },
        getAll: async () => [],
        getChildren: async () => [],
        applyDerivedSpec: async () => {
          /* no-op */
        },
        // Stubs for the rest of the DeviceManagerApi surface — the
        // tests don't exercise these but the type contract requires
        // them for the fake context to satisfy AddonContext.
        loadConfig: async () => ({}),
        persistInitialConfig: async () => 0,
        setName: async () => {
          /* no-op */
        },
        setLocation: async () => {
          /* no-op */
        },
        setDisabled: async () => {
          /* no-op */
        },
      },
    },
    api: fakeApi as AddonContext['api'],
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      installPythonRequirements: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      // ── Phase 2 raw store accessors (the only surface on AddonContext
      // .settings after the post-Phase-13 cleanup). ────────────────────
      async readAddonStore() {
        // `[TEST-HARNESS-EXPLICIT]` — tests must set `enabledNodes`
        // explicitly in `initialGlobalSettings`. Previously this getter
        // auto-populated the list from the fake broker's node registry
        // when the caller omitted the field, saving boilerplate but
        // hiding the real contract and adding test-only magic that
        // diverged from production `SettingsResolverService`. Now the
        // harness is a plain passthrough: whatever the test seeded is
        // what the orchestrator reads.
        return { ...store.global }
      },
      async writeAddonStore(patch) {
        store.global = { ...store.global, ...patch }
      },
      readDeviceStoreBatch: async (ids: readonly number[]) =>
        new Map(ids.map((id) => [id, { ...store.devices.get(id) }])),
      listDeviceStoreIds: async () => [...store.devices.keys()],
      async readDeviceStore(deviceId: number) {
        return { ...store.devices.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        const existing = store.devices.get(deviceId) ?? {}
        const next = { ...existing, ...patch }
        store.devices.set(deviceId, next)
      },
      async clearDeviceStore(deviceId: number) {
        store.devices.delete(deviceId)
      },
      // yml-section pair — orchestrator tests never read yml, so we
      // return empty / no-op but keep the contract intact.
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
      // Per-device runtime-state — backs the unified
      // `device-state.setCapSlice` write path. Orchestrator tests
      // don't depend on persistence; an in-memory map keeps the
      // contract intact without leaking state across runs (the
      // surrounding `store` is recreated per-test).
      async readDeviceRuntimeState(deviceId: number) {
        return (store.deviceRuntimeStates.get(deviceId) ?? {}) as Record<string, unknown>
      },
      async writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>) {
        store.deviceRuntimeStates.set(deviceId, { ...data })
      },
      async clearDeviceRuntimeState(deviceId: number) {
        store.deviceRuntimeStates.delete(deviceId)
      },
    },
    // Test-harness boundary casts: `getNativeProvider`/`fetchDevice` are
    // generic over TCap / return a concrete DeviceProxy. The harness stores
    // opaque seeded providers/devices and the narrowing happens at the
    // caller's usage site in the test body. Callers that consume these
    // retain their strict types via the cap def; the harness itself cannot
    // realise the generic.
    getNativeProvider: <TCap extends import('@camstack/types').CapabilityDefinition>(
      cap: TCap,
      deviceId: number,
    ): import('@camstack/types').InferProvider<TCap> => {
      const provider = opts.nativeProviders?.get(`${cap.name}:${deviceId}`)
      if (provider == null) {
        throw new Error(
          `test harness: no native provider seeded for '${cap.name}' on '${deviceId}' — ` +
            `pass FakeContextOptions.nativeProviders with the '${cap.name}:${deviceId}' key`,
        )
      }
      return provider as import('@camstack/types').InferProvider<TCap>
    },
    fetchDevice: async (deviceId) => {
      const device = opts.devices?.get(deviceId)
      if (device == null) {
        throw new Error(
          `test harness: no device seeded for '${deviceId}' — ` +
            `pass FakeContextOptions.devices with the '${deviceId}' key`,
        )
      }
      return device as import('@camstack/types').DeviceProxy
    },
    // Capability acquisition surface — stubbed. Tests that depend on
    // cap readiness should seed providers via the cap-registry helpers
    // instead of relying on these in-process handles. Kept present so
    // the `AddonContext` shape checks out.
    useCapability: <T = unknown>(): import('@camstack/types').ICapabilityHandle<T> =>
      ({
        isReady: () => true,
        call: async <R>(fn: () => R | Promise<R>) => fn(),
        invalidate: () => {
          /* no-op */
        },
      }) as unknown as import('@camstack/types').ICapabilityHandle<T>,
    acquireCapability: async <T = unknown>(): Promise<
      import('@camstack/types').ICapabilityHandle<T>
    > =>
      ({
        isReady: () => true,
        call: async <R>(fn: () => R | Promise<R>) => fn(),
        invalidate: () => {
          /* no-op */
        },
      }) as unknown as import('@camstack/types').ICapabilityHandle<T>,
    onCapabilityStateChange: () => () => {
      /* no-op */
    },
    addDisposer: () => () => {
      /* no-op */
    },
  }

  return { ctx, store, eventBus: bus, captured, registeredProviders }
}

// ── Fake pipeline-runner provider ─────────────────────────────────────

export interface FakeRunnerOptions {
  readonly nodeId: string
  readonly hasGpu?: boolean
  readonly inferenceBackend?: string
  readonly cpuCores?: number
}

export interface FakeRunner extends IPipelineRunnerProvider {
  readonly attachedCameras: Map<number, RunnerCameraConfig>
  readonly attachHistory: Array<{ action: 'attach' | 'detach'; deviceId: number }>
  /** Node benchmark runs this runner was asked to start (D791). */
  readonly benchStarts: string[]
  /** What `getNodeBenchStatus` answers next for a started run (default: done, no cells). */
  benchState: 'running' | 'done'
}

export function makeFakeRunner(opts: FakeRunnerOptions): FakeRunner {
  const attached = new Map<number, RunnerCameraConfig>()
  const history: Array<{ action: 'attach' | 'detach'; deviceId: number }> = []

  const benchStarts: string[] = []
  const runner: FakeRunner = {
    benchStarts,
    benchState: 'done',
    async startNodeBench(input: { runId: string }) {
      benchStarts.push(input.runId)
      return { accepted: true as const, runId: input.runId }
    },
    async getNodeBenchStatus(input: { runId: string }) {
      if (!benchStarts.includes(input.runId)) return null
      return {
        runId: input.runId,
        nodeId: opts.nodeId,
        state: runner.benchState,
        progress: null,
        cells: [],
        fingerprint: null,
        clip: null,
        activeCameraIds: [],
        deletedModels: [],
        error: null,
        startedAtMs: 0,
        finishedAtMs: null,
      }
    },
    async abortNodeBench() {
      return { aborted: true }
    },
    get attachedCameras() {
      return attached
    },
    get attachHistory() {
      return history
    },

    async attachCamera(config: RunnerCameraConfig) {
      attached.set(config.deviceId, config)
      history.push({ action: 'attach', deviceId: config.deviceId })
      return { success: true as const }
    },
    async detachCamera(input: { deviceId: number }) {
      attached.delete(input.deviceId)
      history.push({ action: 'detach', deviceId: input.deviceId })
      return { success: true as const }
    },
    async reportMotion() {
      return { success: true as const }
    },
    // Two-plane detail dispatch — never exercised by orchestrator tests
    // (the orchestrator only places cameras; detail runs are analytics-
    // driven). Present so the fake keeps satisfying IPipelineRunnerProvider.
    async runDetailSubtree() {
      return null
    },
    // Stateless single-step execution — likewise never exercised here, and
    // deliberately a REFUSAL rather than a fake success: a fake that supplies
    // what production forgot to fetch is how this repo has twice shipped a
    // green suite over a live defect.
    async runStatelessStep() {
      return {
        kind: 'refused' as const,
        nodeId: opts.nodeId,
        reason: 'unknown-step' as const,
        detail: 'orchestrator e2e fake runner does not execute steps',
      }
    },
    // The parked-frame parcel (D422) — analytics-driven, never exercised by
    // orchestrator tests. A REFUSAL, for the same reason `runStatelessStep`
    // refuses: a fake that parks what production could not is a green suite
    // over a live defect.
    async parkTrackFrame() {
      return {
        parked: false as const,
        nodeId: opts.nodeId,
        reason: 'handle-gone' as const,
        handleAgeMs: null,
        detail: 'orchestrator e2e fake runner holds no pixels',
      }
    },
    async getParkedTrackFrame() {
      return null
    },
    async releaseParkedTrackFrames() {
      return { released: 0 }
    },
    async getLocalLoad(): Promise<RunnerLocalLoad> {
      return {
        nodeId: opts.nodeId,
        attachedCameras: attached.size,
        activeCameras: attached.size,
        avgInferenceFps: 10,
        avgInferenceTimeMs: 40,
        queueDepthTotal: 0,
        devices: [],
        hardware: {
          hasGpu: opts.hasGpu ?? false,
          inferenceBackend: opts.inferenceBackend,
          cpuCores: opts.cpuCores,
        },
        // A current runner (D696): it does not write the camera `motion` slice.
        motionSliceWriter: 'orchestrator',
      }
    },
    async getLocalMetrics(): Promise<RunnerLocalMetrics> {
      return {
        nodeId: opts.nodeId,
        activeCameras: attached.size,
        throttledCameras: 0,
        avgInferenceTimeMs: 40,
        queueDepth: 0,
      }
    },
    async getCameraMetrics(input: { deviceId: number }): Promise<CameraMetrics | null> {
      if (!attached.has(input.deviceId)) return null
      return {
        detectionMode: 'on-motion',
        phase: 'active',
        configuredFps: 10,
        actualFps: 10,
        queueDepth: 0,
        avgInferenceTimeMs: 40,
        droppedFrames: 0,
      }
    },
    getAllCameraMetrics() {
      return [...attached.keys()].map((deviceId) => ({
        deviceId,
        detectionMode: 'on-motion' as const,
        audioMode: 'always-on' as const,
        phase: 'active' as const,
        configuredFps: 10,
        actualFps: 10,
        queueDepth: 0,
        avgInferenceTimeMs: 40,
        droppedFrames: 0,
      }))
    },
    getLocalCameras() {
      return [...attached.keys()]
    },
  }

  return runner
}

/**
 * Wire a fake runner onto a fake broker under a given nodeId — registers
 * the Moleculer action surface the orchestrator calls (attachCamera /
 * detachCamera / getLocalLoad) and marks the pipeline-runner service as
 * present on that node for `getNodeList(withServices)` queries.
 */
export function wireRunnerToBroker(broker: FakeBroker, nodeId: string, runner: FakeRunner): void {
  broker.registerService(nodeId, 'pipeline-runner')
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.attachCamera', (input) =>
    runner.attachCamera(input as RunnerCameraConfig),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.detachCamera', (input) =>
    runner.detachCamera(input as { deviceId: number }),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.getLocalLoad', () =>
    runner.getLocalLoad(),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.getLocalCameras', () =>
    runner.getLocalCameras(),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.startNodeBench', (input) =>
    runner.startNodeBench(input as never),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.getNodeBenchStatus', (input) =>
    runner.getNodeBenchStatus(input as never),
  )
  broker.registerAction(nodeId, 'pipeline-runner.pipeline-runner.abortNodeBench', (input) =>
    runner.abortNodeBench(input as never),
  )
}

/** Build a valid RunnerCameraConfig for test inputs. */
export function makeRunnerCameraConfig(
  deviceId: number,
  overrides: Partial<RunnerCameraConfig> = {},
): RunnerCameraConfig {
  return {
    deviceId,
    detectionMode: 'on-motion',
    audioMode: 'always-on',
    motionCooldownMs: 10_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionSources: ['analyzer'],
    pipelineEnabled: true,
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: true,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fake stream-broker / audio-analyzer / device-registry / analysis-pipeline
// ─────────────────────────────────────────────────────────────────────
//
// These helpers back the detection-wiring E2E scenarios (the suite the
// orchestrator inherited from the deleted kernel DetectionWiringService).
// Everything here is deterministic, synchronous-ish and has zero external
// dependencies — the goal is to exercise the addon's event-bus wiring and
// settings resolution without spinning up a real stream pipeline.

// ── Fake IStreamBroker (per-device broker instance) ──────────────────

export interface FakeStreamBroker extends IStreamBroker {
  /** Manually enqueue a decoded audio chunk on every audio-chunk subscription. */
  emitAudioChunk(chunk: DecodedAudioChunk): void
  /** Read-only list of open audio-chunk subscription ids for assertions. */
  readonly audioSubscribers: ReadonlyArray<string>
}

export function makeFakeStreamBroker(deviceId: string): FakeStreamBroker {
  // Per-subscription FIFO queues — mirrors the broker's `AudioChunkPlane`
  // (Phase 5 / D9). The orchestrator's `AudioChunkPoller` drains these.
  const audioQueues = new Map<string, DecodedAudioChunk[]>()
  let audioSubSeq = 0

  const broker: FakeStreamBroker = {
    deviceId,
    status: 'streaming',
    async start() {
      /* no-op */
    },
    async stop() {
      /* no-op */
    },
    onEncodedData: () => () => {
      /* no-op */
    },
    // Re-tags subscribers by session id; tests never establish WebRTC
    // sessions through the fake broker, so nothing matches → false.
    updateConsumerAttributionBySession: () => false,
    // Tests don't exercise SDP-parameter-set forwarding; the no-op
    // matches the IStreamBroker contract for non-RTSP push sources.
    onSdpParameterSets: () => () => {
      /* no-op */
    },
    subscribeAudioChunks() {
      audioSubSeq += 1
      const subscriptionId = `fake-ac-${audioSubSeq}`
      audioQueues.set(subscriptionId, [])
      return { subscriptionId }
    },
    pullAudioChunks(subscriptionId, maxCount) {
      const queue = audioQueues.get(subscriptionId)
      if (!queue) return []
      return queue.splice(0, maxCount)
    },
    unsubscribeAudioChunks(subscriptionId) {
      return audioQueues.delete(subscriptionId)
    },
    getStats() {
      return {
        status: 'streaming',
        inputFps: 0,
        encodedSubscribers: 0,
        uptimeMs: 0,
        bitrateKbps: 0,
        idrIntervalMs: 0,
        totalBytes: 0,
        packetCount: 0,
        rtspClients: 0,
        pipeClients: 0,
        preBufferSec: 0,
        preBufferMs: 0,
        preBufferPackets: 0,
      }
    },
    getLocalStreamUrl() {
      return `rtsp://localhost/${deviceId}`
    },
    get suspended() {
      return false
    },
    pushEncodedPacket() {
      /* no-op */
    },
    setPreBufferEnabled() {
      /* no-op */
    },
    getPreBuffer() {
      return []
    },
    getRtpPreBuffer() {
      return []
    },
    setPreBufferDuration() {
      /* no-op */
    },
    getPreBufferDuration() {
      return 0
    },
    // RTP / SDP surface — Phase 6 stream-broker contract used by the
    // H.265 repacketizer path. Orchestrator tests don't simulate RTP
    // forwarding, so these are no-ops that satisfy the interface.
    onVideoRtp: () => () => {
      /* no-op */
    },
    getSdpParameterSets: () => null,
    // Source re-dials are a WebRTC-session concern; the orchestrator tests
    // never re-dial, so this is a no-op that satisfies the contract.
    onSourceRestart: () => () => {
      /* no-op */
    },
    getSourceType: () => null,
    isRtpSource: () => false,
    emitAudioChunk(chunk: DecodedAudioChunk) {
      for (const queue of audioQueues.values()) {
        queue.push(chunk)
      }
    },
    get audioSubscribers(): ReadonlyArray<string> {
      return [...audioQueues.keys()]
    },
  }
  return broker
}

// ── Fake stream-broker capability surface (what the orchestrator reads) ──

/** Simplified ProfileSlot — mirrors the shape from `@camstack/types`. */
interface FakeProfileSlot {
  readonly deviceId: number
  readonly profile: 'high' | 'mid' | 'low'
  readonly brokerId: string
  readonly sourceCamStreamId: string | null
  readonly status: 'idle' | 'streaming' | 'unassigned' | 'connecting' | 'error'
}

export interface FakeStreamBrokerCap {
  /**
   * Audio-chunk plane (Phase 5 / D9) — the orchestrator's `AudioChunkPoller`
   * reaches the broker through these cap methods, never a live object.
   */
  subscribeAudioChunks(input: { brokerId: string; tag?: string }): { subscriptionId: string }
  pullAudioChunks(input: { subscriptionId: string; maxCount: number }): readonly DecodedAudioChunk[]
  unsubscribeAudioChunks(input: { subscriptionId: string }): { released: boolean }

  /** Full dump of every assigned profile slot across every registered device. */
  listAllProfileSlots(): readonly FakeProfileSlot[]

  /**
   * The BROKER's per-device audio-plane policy (D83). Modelled here because
   * it genuinely lives in the broker's own `DeviceOverride` store — a fake
   * that let the orchestrator keep it would hide the whole point of the row.
   */
  getDeviceAudioMute(input: { deviceId: number }): { muted: boolean; appliedBrokers: number }
  setDeviceAudioMute(input: { deviceId: number; muted: boolean }): {
    muted: boolean
    appliedBrokers: number
  }

  // Test-facing registration helpers
  register(deviceId: number, providerId: string, streams: readonly StreamSourceEntry[]): void
  attachBroker(brokerId: string, broker: IStreamBroker): void
}

export function makeFakeStreamBrokerCap(): FakeStreamBrokerCap {
  const devices = new Map<
    number,
    {
      deviceId: number
      providerId: string
      streams: readonly StreamSourceEntry[]
      deviceName?: string
    }
  >()
  const brokers = new Map<string, IStreamBroker>()
  // Routes an audio-chunk subscription id back to its owning broker —
  // mirrors `StreamBrokerManager.audioSubscriptionBroker`.
  const audioSubscriptionBroker = new Map<string, string>()
  /** D83: the broker's own per-device audio-plane policy. */
  const audioMuted = new Set<number>()

  return {
    getDeviceAudioMute({ deviceId }) {
      const muted = audioMuted.has(deviceId)
      return { muted, appliedBrokers: muted ? 1 : 0 }
    },
    setDeviceAudioMute({ deviceId, muted }) {
      if (muted) audioMuted.add(deviceId)
      else audioMuted.delete(deviceId)
      return { muted, appliedBrokers: muted ? 1 : 0 }
    },
    subscribeAudioChunks({ brokerId, tag }) {
      const broker = brokers.get(brokerId)
      if (!broker) throw new Error(`fake stream-broker: no broker for "${brokerId}"`)
      const result = broker.subscribeAudioChunks({ tag })
      audioSubscriptionBroker.set(result.subscriptionId, brokerId)
      return result
    },
    pullAudioChunks({ subscriptionId, maxCount }) {
      const brokerId = audioSubscriptionBroker.get(subscriptionId)
      if (!brokerId) return []
      const broker = brokers.get(brokerId)
      if (!broker) return []
      return broker.pullAudioChunks(subscriptionId, maxCount)
    },
    unsubscribeAudioChunks({ subscriptionId }) {
      const brokerId = audioSubscriptionBroker.get(subscriptionId)
      if (!brokerId) return { released: false }
      audioSubscriptionBroker.delete(subscriptionId)
      const broker = brokers.get(brokerId)
      if (!broker) return { released: false }
      return { released: broker.unsubscribeAudioChunks(subscriptionId) }
    },
    listAllProfileSlots(): readonly FakeProfileSlot[] {
      const out: FakeProfileSlot[] = []
      for (const info of devices.values()) {
        for (const stream of info.streams) {
          // Brokers are now keyed by `${deviceId}/${camStreamId}` —
          // mirror that here so fakes emit the same broker id shape
          // the production stream-broker uses.
          const raw = stream.profileHint ?? stream.id
          const profile = raw === 'high' || raw === 'mid' || raw === 'low' ? raw : 'high'
          out.push({
            deviceId: info.deviceId,
            profile,
            brokerId: `${info.deviceId}/${stream.id}`,
            sourceCamStreamId: stream.id,
            status: 'streaming',
          })
        }
      }
      return out
    },
    register(deviceId, providerId, streams) {
      devices.set(deviceId, { deviceId, providerId, streams, deviceName: String(deviceId) })
    },
    attachBroker(brokerId, broker) {
      brokers.set(brokerId, broker)
    },
  }
}

// ── Fake audio analyzer ─────────────────────────────────────────────

export interface FakeAudioAnalyzerOptions {
  /** Device settings resolver override (defaults to a static DTO). */
  readonly resolver?: (deviceId: number) => Promise<AudioAnalysisSettings | null>
  /** Level metrics per chunk (defaults to fixed { rms: 0.5, dbfs: -6 }). */
  readonly level?: { rms: number; dbfs: number }
  /** Classifications to produce on every chunk. */
  readonly classifications?: ReadonlyArray<{ className: string; score: number }>
}

/** One `attachDevice` the orchestrator made, in call order. */
export interface FakeAudioAttach {
  readonly deviceId: number
  readonly brokerId: string
  readonly ingestNodeId: string
  readonly settings: AudioAnalysisSettings
}

export interface FakeAudioAnalyzer extends IAudioAnalyzer {
  readonly processedChunks: number
  /**
   * Every `attachDevice` / `detachDevice` the orchestrator issued (D461).
   *
   * The orchestrator no longer drains the chunk plane, so there is nothing for
   * `processedChunks` to count on this side any more and these are what the
   * orchestrator's e2e can honestly assert: it decided this camera's audio
   * runs, against this broker, on this node. What happens to the bytes after
   * that is `audio-device-attachments.spec.ts`'s subject, against the real
   * poller and the real accumulator — not a fake standing in for both.
   */
  readonly attaches: readonly FakeAudioAttach[]
  readonly detaches: readonly number[]
}

export function makeFakeAudioAnalyzer(opts: FakeAudioAnalyzerOptions = {}): FakeAudioAnalyzer {
  let count = 0
  const level = opts.level ?? { rms: 0.5, dbfs: -6 }
  const classifications = opts.classifications ?? []
  const attaches: FakeAudioAttach[] = []
  const detaches: number[] = []
  const analyzer: FakeAudioAnalyzer = {
    get processedChunks() {
      return count
    },
    get attaches() {
      return attaches
    },
    get detaches() {
      return detaches
    },
    async attachDevice(input: FakeAudioAttach): Promise<{
      attached: boolean
      replaced: boolean
    }> {
      const replaced = attaches.some((a) => a.deviceId === input.deviceId)
      attaches.push(input)
      return { attached: true, replaced }
    },
    async detachDevice({ deviceId }: { deviceId: number }): Promise<{ detached: boolean }> {
      detaches.push(deviceId)
      return { detached: true }
    },
    async analyseChunk(_input: {
      chunk: AudioChunkInput
      settings: AudioAnalysisSettings
    }): Promise<AudioAnalysisResult | null> {
      count += 1
      return {
        level,
        classification:
          classifications.length > 0 ? { labels: classifications, inferenceMs: 3 } : undefined,
        classifyOutcome: { state: 'classified' },
        timestamp: Date.now(),
      }
    },
    async resolveDeviceSettings({
      deviceId,
    }: {
      deviceId: number
    }): Promise<AudioAnalysisSettings | null> {
      if (opts.resolver) return opts.resolver(deviceId)
      return { minConfidence: 0.3, allowedClasses: [] }
    },
    isReady() {
      return true
    },
    async dispose() {
      /* no-op */
    },
  }
  return analyzer
}

// ── Fake device registry reader ─────────────────────────────────────

let nextFakeCameraId = 1_000_000

export function makeFakeCameraDevice(
  stableId: string,
  streams: readonly StreamSourceEntry[],
): ICameraDevice {
  const ctx: {
    stableId: string
    logger: ReturnType<typeof makeSilentLogger>
    api: undefined
    eventBus: ReturnType<typeof makeLocalEventBus>['bus']
    persistConfig: () => Promise<void>
    devices: never
  } = {
    stableId: 'provider-rtsp',
    logger: makeSilentLogger(),
    api: undefined,
    eventBus: makeLocalEventBus().bus,
    persistConfig: async () => {
      /* no-op */
    },
    devices: undefined as never,
  }
  const id = nextFakeCameraId++
  const device: ICameraDevice = {
    id,
    stableId,
    name: stableId,
    type: DeviceType.Camera,
    parentDeviceId: null,
    ctx: ctx as never,
    snapshot: () => ({ stableId, name: stableId, type: DeviceType.Camera }),
    async getStreamSources() {
      return streams
    },
  } as unknown as ICameraDevice
  return device
}

export function makeFakeDeviceRegistry(...devices: IDevice[]): IDeviceRegistryReader & {
  add(device: IDevice): void
  clear(): void
} {
  const map = new Map<number, IDevice>()
  for (const d of devices) map.set(d.id, d)
  return {
    getAll: () => [...map.values()],
    getById: (id: number) => map.get(id) ?? null,
    getAddonId: (_id: number) => null,
    getChildren: () => [],
    add(device) {
      map.set(device.id, device)
    },
    clear() {
      map.clear()
    },
  }
}

// ── Fake analysis-pipeline ──────────────────────────────────────────

export interface FakeAnalysisPipelineOptions {
  /** Optional transform: return an enriched FrameResult + analysis events. */
  readonly process?: (deviceId: string, frame: FrameResult | undefined) => AnalysisFrameOutput
}

export function makeFakeAnalysisPipeline(opts: FakeAnalysisPipelineOptions = {}): IAnalysisAddon {
  return {
    async initialize() {
      /* no-op */
    },
    async shutdown() {
      /* no-op */
    },
    getConfigSchema() {
      return { sections: [] }
    },
    getConfig() {
      return {}
    },
    async onConfigChange() {
      /* no-op */
    },
    async processFrame(
      deviceId: string,
      _frame: FrameInput,
      pipelineResult?: FrameResult,
    ): Promise<AnalysisFrameOutput> {
      if (opts.process) return opts.process(deviceId, pipelineResult)
      // Default: pass-through, no events, no enrichment.
      return { events: [], enrichedFrame: null }
    },
    getLiveState(): CameraLiveState | null {
      return null
    },
    getTracks(): TrackedObjectSummary[] {
      return []
    },
    getZoneState(): ZoneLiveState | null {
      return null
    },
    async getZoneHistory(): Promise<ZoneHistoryPoint[]> {
      return []
    },
    async getHeatmap(): Promise<HeatmapData> {
      return { width: 0, height: 0, gridSize: 0, cells: new Float32Array(0), maxCount: 0 }
    },
    getTrackDetail(): TrackDetail | null {
      return null
    },
    getCameraStatus(): PipelineStatus[] {
      return []
    },
    setCameraPipeline() {
      /* no-op */
    },
    setKnownFaces() {
      /* no-op */
    },
    setKnownPlates() {
      /* no-op */
    },
    onLiveStateChange() {
      return () => {
        /* no-op */
      }
    },
  } as unknown as IAnalysisAddon
}

/**
 * Satisfy the TS import cluster — these are the types we consume but
 * only reference in function signatures above. Importing them at the
 * top of the file keeps the generated .d.ts files coherent.
 */
export type {
  DetectionEvent,
  IStreamBroker,
  DecodedAudioChunk,
  IAudioAnalyzer,
  IDeviceRegistryReader,
  IAnalysisAddon,
  FrameResult,
  FrameInput,
  AnalysisFrameOutput,
  MotionSource,
  KnownFace,
  KnownPlate,
  CameraLiveState,
  TrackedObjectSummary,
  ZoneLiveState,
  TrackDetail,
  TrackFilter,
  ZoneHistoryPoint,
  HeatmapData,
  HeatmapOptions,
  TimeRangeOptions,
  PipelineStatus,
}
