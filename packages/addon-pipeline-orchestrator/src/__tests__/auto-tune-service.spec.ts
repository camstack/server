/**
 * D745, D755 — Auto tune plan and apply over fake I/O: the confirmed hash is
 * what gets written, a stale hash writes nothing, a failed download writes
 * nothing, an offline node is skipped, a second apply is refused while one
 * runs, and only touched nodes are re-dispatched. The plan is sized by a
 * capacity floor and nothing else; the shares are capacity, one pass.
 */
import type {
  HardwareInfo,
  NodeInferenceDevices,
  NodeMeasuredCapacity,
  PipelineSchema,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AutoTuneService, type AutoTuneServiceDeps } from '../auto-tune/auto-tune-service.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'
import { makeSilentLogger } from './e2e-helpers.js'

function hw(cpuModel: string, arch: HardwareInfo['arch']): HardwareInfo {
  return {
    platform: arch === 'arm64' ? 'darwin' : 'linux',
    arch,
    cpuModel,
    cpuCores: 8,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
  }
}

type ModelOption = PipelineSchema['slots'][number]['addons'][number]['models'][number]
type DeviceRow = NodeInferenceDevices['devices'][number]

const MODELS: readonly ModelOption[] = ['t', 's', 'm'].flatMap((tier): ModelOption[] =>
  ['320', '640'].flatMap((res): ModelOption[] => [
    {
      id: `yolov9${tier}-${res}`,
      name: '',
      formats: {
        onnx: { downloaded: true, sizeMB: 1 },
        openvino: { downloaded: true, sizeMB: 1 },
        coreml: { downloaded: true, sizeMB: 1 },
      },
    },
    {
      id: `yolov9${tier}-${res}-int8`,
      name: '',
      formats: { openvino: { downloaded: true, sizeMB: 1 } },
    },
  ]),
)

const CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'object-detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          childSlots: [],
          defaultModelId: 'yolov9m-320-int8',
          defaultConfidence: 0.5,
          models: MODELS,
          configSchema: [
            {
              key: 'minConfidencePerson',
              label: 'Person',
              type: 'slider',
              min: 0,
              max: 1,
              step: 0.05,
              default: 0.65,
              bindsToModel: true,
            },
          ],
        },
      ],
    },
  ],
}

function devices(
  nodeId: string,
  reachable: boolean,
  keys: readonly [string, string][],
): NodeInferenceDevices {
  return {
    nodeId,
    reachable,
    devices: keys.map(
      ([key, format]): DeviceRow => ({
        key,
        backend: key.split(':')[0] ?? key,
        device: key.split(':')[1] ?? key,
        format: format === 'coreml' ? 'coreml' : format === 'onnx' ? 'onnx' : 'openvino',
        available: true,
        enabled: true,
        weight: 1,
        maxSessions: null,
        defaultModelId: 'yolov9m-320-int8',
        exclusion: null,
      }),
    ),
  }
}

interface World {
  agent: AgentSettingsMapBlob
  downloads: string[]
  redispatched: string[]
  failDownload: boolean
  macReachable: boolean
  /** The fastest camera running the pipeline root (default 10). */
  cameraFps?: number | null
  /** Node benchmark results, for the `benchmark` share source. */
  measured?: ReadonlyMap<string, NodeMeasuredCapacity>
  /** Custom-registry model ids; `null` = the registry does not answer. */
  customIds?: ReadonlySet<string> | null
}

function makeDeps(world: World): AutoTuneServiceDeps {
  const hardware: Record<string, HardwareInfo> = {
    hub: hw('Intel(R) Core(TM) Ultra 7 265K', 'x64'),
    'agent-a': hw('Intel(R) N100', 'x64'),
    mac: hw('Apple M2', 'arm64'),
  }
  return {
    logger: makeSilentLogger(),
    runnerNodeIds: () => ['hub', 'agent-a', 'mac'],
    readNodeDevices: async (nodeId) =>
      nodeId === 'hub'
        ? devices('hub', true, [
            ['openvino:gpu', 'openvino'],
            ['openvino:npu', 'openvino'],
          ])
        : nodeId === 'agent-a'
          ? devices('agent-a', true, [['openvino:gpu', 'openvino']])
          : devices('mac', world.macReachable, [['coreml:all', 'coreml']]),
    readHardware: async (nodeId) => hardware[nodeId] ?? null,
    readCatalog: async () => CATALOG,
    readAgentSettings: async () => world.agent,
    rewriteAgentSettings: async (t) => {
      world.agent = t(world.agent)
    },
    cameraFps: async () => (world.cameraFps === undefined ? 10 : world.cameraFps),
    measuredCapacity: { readMeasuredCapacity: async () => world.measured ?? new Map() },
    downloadModel: async (nodeId, modelId) => {
      if (world.failDownload) throw new Error('offline mirror')
      world.downloads.push(`${nodeId}:${modelId}`)
    },
    readCustomModelIds: async () => {
      if (world.customIds === null) throw new Error('registry down')
      return world.customIds ?? new Set()
    },
    invalidateCatalog: () => undefined,
    redispatch: async (nodeId) => {
      world.redispatched.push(nodeId)
    },
    now: () => 1_000,
  }
}

function newWorld(): World {
  return {
    agent: {
      hub: {
        maxCameras: null,
        inferenceDevices: { 'openvino:gpu': { enabled: true, weight: 50 } },
      },
    },
    downloads: [],
    redispatched: [],
    failDownload: false,
    macReachable: true,
  }
}

describe('AutoTuneService', () => {
  it('plans the operator cluster and applies exactly the confirmed plan', async () => {
    const world = newWorld()
    const service = new AutoTuneService(makeDeps(world))
    const plan = await service.plan({ headroom: 0.4 })
    expect(plan.minSessionsPerDevice).toBe(2)
    expect(plan.nodes.map((n) => [n.nodeId, n.acceleratorModelId])).toEqual([
      ['agent-a', 'yolov9s-320-int8'],
      ['hub', 'yolov9m-640-int8'],
      ['mac', 'yolov9m-640'],
    ])
    expect(world.agent.hub?.inferenceDevices?.['openvino:gpu']?.steps).toBeUndefined()

    const result = await service.apply({ planHash: plan.planHash, headroom: 0.4 })
    expect(result.kind).toBe('applied')
    expect(world.agent.hub?.inferenceDevices?.['openvino:gpu']).toEqual({
      enabled: true,
      weight: 50,
      steps: { 'object-detection': { modelId: 'yolov9m-640-int8' } },
    })
    expect(
      world.agent.mac?.inferenceDevices?.['coreml:all']?.steps?.['object-detection']?.modelId,
    ).toBe('yolov9m-640')
    expect(world.downloads.toSorted()).toEqual([
      'agent-a:yolov9s-320-int8',
      'hub:yolov9m-640-int8',
      'mac:yolov9m-640',
    ])
    expect(world.redispatched).toEqual(['agent-a', 'hub', 'mac'])
  })

  it('a stale hash writes nothing and returns the fresh plan', async () => {
    const world = newWorld()
    const service = new AutoTuneService(makeDeps(world))
    const before = structuredClone({ agent: world.agent })
    const result = await service.apply({ planHash: 'not-the-plan', headroom: 0.4 })
    expect(result.kind).toBe('stale')
    expect({ agent: world.agent }).toEqual(before)
    expect(world.downloads).toEqual([])
  })

  it('a failed download writes nothing', async () => {
    const world = newWorld()
    const service = new AutoTuneService(makeDeps(world))
    const plan = await service.plan({ headroom: 0.4 })
    world.failDownload = true
    const before = structuredClone({ agent: world.agent })
    const result = await service.apply({ planHash: plan.planHash, headroom: 0.4 })
    expect(result.kind === 'aborted' && result.phases).toEqual([
      { phase: 'download', ok: false, detail: 'offline mirror' },
    ])
    expect({ agent: world.agent }).toEqual(before)
    expect(world.redispatched).toEqual([])
  })

  it('an offline node is skipped: no writes and no redispatch on it', async () => {
    const world = newWorld()
    world.macReachable = false
    const service = new AutoTuneService(makeDeps(world))
    const plan = await service.plan({ headroom: 0.4 })
    expect(plan.nodes.find((n) => n.nodeId === 'mac')?.reasons).toEqual([{ kind: 'node-offline' }])
    await service.apply({ planHash: plan.planHash, headroom: 0.4 })
    expect(world.agent.mac).toBeUndefined()
    expect(world.redispatched).toEqual(['agent-a', 'hub'])
  })

  it('a second apply while one runs is refused', async () => {
    const world = newWorld()
    const deps = makeDeps(world)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new AutoTuneService({
      ...deps,
      downloadModel: async (nodeId, modelId, format) => {
        await gate
        await deps.downloadModel(nodeId, modelId, format)
      },
    })
    const plan = await service.plan({ headroom: 0.4 })
    const first = service.apply({ planHash: plan.planHash, headroom: 0.4 })
    await new Promise((r) => setTimeout(r, 0))
    const second = await service.apply({ planHash: plan.planHash, headroom: 0.4 })
    expect(second).toEqual({ kind: 'refused', reason: 'apply-in-progress' })
    release()
    expect((await first).kind).toBe('applied')
  })
})

describe('AutoTuneService — the capacity floor (D755)', () => {
  it('the floor is part of the plan: a different floor is a different plan, and apply re-plans with the confirmed one', async () => {
    const world = newWorld()
    const service = new AutoTuneService(makeDeps(world))
    const two = await service.plan({ headroom: 0.4 })
    const one = await service.plan({ headroom: 0.4, minSessionsPerDevice: 1 })
    // m-320-int8 was re-measured at 15 fps on the N100 (2026-10-24) and no longer
    // clears one 10 fps session with headroom; the yolov9t-640 cell still does.
    expect(one.nodes.find((n) => n.nodeId === 'agent-a')?.acceleratorModelId).toBe('yolov9t-640')
    expect(one.planHash).not.toBe(two.planHash)
    // Confirming the floor-1 plan with the default floor is stale; with its own floor it applies.
    expect((await service.apply({ planHash: one.planHash, headroom: 0.4 })).kind).toBe('stale')
    expect(
      (await service.apply({ planHash: one.planHash, headroom: 0.4, minSessionsPerDevice: 1 }))
        .kind,
    ).toBe('applied')
  })

  it('reasons say the capacity against the floor', async () => {
    const plan = await new AutoTuneService(makeDeps(newWorld())).plan({ headroom: 0.4 })
    const n100 = plan.nodes.find((n) => n.nodeId === 'agent-a')?.devices[0]
    expect(n100?.reasons[0]).toEqual({ kind: 'capacity', sessions: 2, minSessions: 2 })
  })

  it('with no camera running the root, a session counts at 10 fps', async () => {
    const plan = await new AutoTuneService(makeDeps({ ...newWorld(), cameraFps: null })).plan({
      headroom: 0.4,
    })
    expect(plan.cameraFps).toBe(10)
  })
})

describe('AutoTuneService — shares (D755)', () => {
  it('hardware: shares in proportion to capacity at the Auto tune models, in one pass', async () => {
    const result = await new AutoTuneService(makeDeps(newWorld())).suggestShares({ headroom: 0.4 })
    expect(result.source).toBe('hardware')
    expect(result.nodes.map((n) => [n.nodeId, n.capacitySessions, n.share])).toEqual([
      ['agent-a', 2, 17],
      ['hub', 5, 42],
      ['mac', 5, 41],
    ])
    const hub = result.nodes.find((n) => n.nodeId === 'hub')
    expect(hub?.devices.map((d) => [d.deviceKey, d.suggestedMaxSessions])).toEqual([
      ['openvino:gpu', 2],
      ['openvino:npu', 3],
    ])
  })

  it('the answer depends on nothing but capacity: asked twice, it is the same', async () => {
    const service = new AutoTuneService(makeDeps(newWorld()))
    expect(await service.suggestShares({ headroom: 0.4 })).toEqual(
      await service.suggestShares({ headroom: 0.4 }),
    )
  })

  it('benchmark: a node with results is sized by them, the others fall back to hardware and say so', async () => {
    const measured = new Map<string, NodeMeasuredCapacity>([
      [
        'agent-a',
        {
          nodeId: 'agent-a',
          devices: [
            {
              deviceKey: 'openvino:gpu',
              maxSessions: 3,
              modelId: 'yolov9s-320-int8',
              measuredAtMs: 1,
            },
          ],
        },
      ],
    ])
    const result = await new AutoTuneService(makeDeps({ ...newWorld(), measured })).suggestShares({
      headroom: 0.4,
      source: 'benchmark',
    })
    expect(
      result.nodes.map((n) => [n.nodeId, n.capacitySource, n.capacityFallback, n.share]),
    ).toEqual([
      ['agent-a', 'benchmark', null, 23],
      ['hub', 'hardware', 'no-benchmark-results', 39],
      ['mac', 'hardware', 'no-benchmark-results', 38],
    ])
  })

  it('benchmark results that cannot be read are no results: every node falls back', async () => {
    const deps = makeDeps(newWorld())
    const result = await new AutoTuneService({
      ...deps,
      measuredCapacity: {
        readMeasuredCapacity: async () => {
          throw new Error('store not ready')
        },
      },
    }).suggestShares({ headroom: 0.4, source: 'benchmark' })
    expect(result.nodes.every((n) => n.capacityFallback === 'no-benchmark-results')).toBe(true)
  })

  it('a benchmark cell for another model is ignored and named ONCE, with the device key', async () => {
    const info = vi.fn()
    const deps = makeDeps({
      ...newWorld(),
      measured: new Map<string, NodeMeasuredCapacity>([
        [
          'agent-a',
          {
            nodeId: 'agent-a',
            devices: [
              {
                deviceKey: 'openvino:gpu',
                maxSessions: 0,
                modelId: 'yolov9m-320-int8',
                measuredAtMs: 1,
              },
            ],
          },
        ],
      ]),
    })
    const service = new AutoTuneService({
      ...deps,
      logger: { ...makeSilentLogger(), info },
    })
    const result = await service.suggestShares({ headroom: 0.4, source: 'benchmark' })
    await service.suggestShares({ headroom: 0.4, source: 'benchmark' })
    expect(result.nodes.find((n) => n.nodeId === 'agent-a')?.capacityFallback).toBe(
      'no-benchmark-results',
    )
    const calls = info.mock.calls.filter(([m]) => String(m).includes('another model ignored'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({
      tags: { nodeId: 'agent-a' },
      meta: { deviceKey: 'openvino:gpu', measuredModelId: 'yolov9m-320-int8' },
    })
  })

  describe('custom models (D786)', () => {
    const CUSTOM = 'custom-yolov9m-640-ft'

    function customWorld(): World {
      const world = newWorld()
      world.customIds = new Set([CUSTOM])
      world.agent = {
        hub: {
          maxCameras: null,
          inferenceDevices: {
            'openvino:npu': {
              enabled: true,
              steps: {
                'object-detection': { modelId: CUSTOM, settings: { minConfidencePerson: 0.45 } },
              },
            },
          },
        },
      }
      return world
    }

    it('keeps a custom-pinned node, warns, and tunes the rest', async () => {
      const world = customWorld()
      const service = new AutoTuneService(makeDeps(world))
      const plan = await service.plan({ headroom: 0.4 })

      const hub = plan.nodes.find((n) => n.nodeId === 'hub')
      expect(hub?.devices.filter((d) => d.kept === 'custom-pin').map((d) => d.deviceKey)).toEqual([
        'openvino:gpu',
        'openvino:npu',
      ])
      expect(plan.nodeChanges.some((c) => c.nodeId === 'hub')).toBe(false)
      expect(plan.warnings).toContainEqual({
        kind: 'custom-pin-kept',
        nodeId: 'hub',
        deviceKey: 'openvino:npu',
        modelId: CUSTOM,
      })

      const before = structuredClone({ hub: world.agent.hub })
      const result = await service.apply({ planHash: plan.planHash, headroom: 0.4 })
      expect(result.kind).toBe('applied')
      expect(world.agent.hub).toEqual(before.hub)
      expect(world.downloads.some((d) => d.startsWith('hub:'))).toBe(false)
      expect(
        world.agent['agent-a']?.inferenceDevices?.['openvino:gpu']?.steps?.['object-detection']
          ?.modelId,
      ).toBe('yolov9s-320-int8')
    })

    it('an unreadable registry keeps every pin outside the measured catalog, and says so', async () => {
      const world = customWorld()
      world.customIds = null
      const plan = await new AutoTuneService(makeDeps(world)).plan({ headroom: 0.4 })
      expect(plan.warnings.map((w) => w.kind)).toContain('custom-registry-unreadable')
      expect(plan.nodeChanges.some((c) => c.nodeId === 'hub')).toBe(false)
    })
  })
})

describe('AutoTuneService — node benchmark results (D791)', () => {
  it('measured on the node beats the table: the plan picks from the measurement and names it', async () => {
    const world = newWorld()
    const service = new AutoTuneService({
      ...makeDeps(world),
      measuredLatency: async () =>
        new Map([
          [
            'agent-a',
            {
              'openvino:gpu': {
                'yolov9m-320-int8': { p50Ms: 9, fps: 40, resultId: 'run:0', measuredAtMs: 5 },
              },
            },
          ],
        ]),
    })
    const plan = await service.plan({ headroom: 0.4 })
    const n100 = plan.nodes.find((n) => n.nodeId === 'agent-a')
    expect(n100?.acceleratorModelId).toBe('yolov9m-320-int8')
    expect(n100?.devices[0]?.chosen?.source).toEqual({
      kind: 'node-benchmark',
      resultId: 'run:0',
      measuredAtMs: 5,
    })
    // the other nodes are still sized from the table
    expect(plan.nodes.find((n) => n.nodeId === 'mac')?.devices[0]?.chosen?.source).toEqual({
      kind: 'table',
    })
  })

  it('unreadable results leave the table in charge', async () => {
    const world = newWorld()
    const service = new AutoTuneService({
      ...makeDeps(world),
      measuredLatency: async () => Promise.reject(new Error('store down')),
    })
    const plan = await service.plan({ headroom: 0.4 })
    expect(plan.nodes.find((n) => n.nodeId === 'agent-a')?.acceleratorModelId).toBe(
      'yolov9s-320-int8',
    )
  })
})
