import { describe, expect, it } from 'vitest'
import { supportBenchmarkRun, supportBenchmarkStatus, medianOf } from '../mcp/support-benchmark.js'
import type { SupportDeps } from '../mcp/support-deps.js'
import { asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const ultra = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
  cpuCores: 20,
  totalRAM_MB: 64000,
  availableRAM_MB: 30000,
  gpu: { type: 'intel', name: 'Arc' },
  npu: { type: 'intel-npu' },
}

const npu = (over: object = {}): object => ({
  key: 'openvino:npu',
  backend: 'openvino',
  device: 'npu',
  available: true,
  enabled: true,
  exclusion: null,
  defaultModelId: 'yolov9m-320',
  ...over,
})

function timing(ms: number): object {
  return { debug: { stepTimings: [{ source: 'object-detection', ms }] } }
}

interface Script {
  readonly answers: { readonly [path: string]: unknown }
  readonly sleeps: number[]
  readonly deps: SupportDeps
}

/** Replies of `addons.custom` in order: cold, warm, warm, warm per model. */
function script(runReplies: readonly unknown[], devices: readonly object[] = [npu()]): Script {
  const sleeps: number[] = []
  let n = 0
  return {
    sleeps,
    deps: {
      runner: async () => ({ code: 127, stdout: '', stderr: 'not used' }),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      recycleMs: 123,
    },
    answers: {
      'platformProbe.getHardware': ultra,
      'pipelineOrchestrator.getNodeInferenceDevices': {
        reachable: true,
        devices,
      },
      'pipelineOrchestrator.getNodeBenchmarkStatus': {
        modeNodeId: null,
        run: null,
      },
      'pipelineExecutor.getAddonModels': [
        { id: 'yolov9t-320', formats: { openvino: { downloaded: true } } },
      ],
      'pipelineExecutor.downloadModel': {},
      'nodes.restartAddon': {},
      'pipelineExecutor.rearmInferenceDevice': {},
      'addons.custom': () => {
        const reply = runReplies[n++] ?? new Error('no scripted reply')
        if (reply instanceof Error) throw reply
        return reply
      },
    },
  }
}

const ARGS = {
  nodeId: 'hub',
  deviceKey: 'openvino:npu',
  models: ['yolov9t-320', 'yolov9s-320'],
  warmRuns: 3,
}

describe('support_benchmark_run', () => {
  it('answers no-session without a hub', async () => {
    const s = script([])
    expect(await supportBenchmarkRun(noSessionContext(), s.deps, ARGS, undefined)).toMatchObject({
      status: 'no-session',
    })
  })

  it('refuses a credential that is not admin-scoped', async () => {
    const s = script([])
    const ctx = await asProtectedTier(gatedHub(s.answers).ctx)
    expect(await supportBenchmarkRun(ctx, s.deps, ARGS, undefined)).toMatchObject({
      status: 'refused',
    })
  })

  it('dry run: the plan and the table row, and it loads nothing', async () => {
    const s = script([])
    const hub = gatedHub(s.answers)
    const dry = await supportBenchmarkRun(hub.ctx, s.deps, ARGS, undefined)
    const view = dryRunOf(dry)
    expect(view.token).toBeDefined()
    expect(view.describe).toMatchObject({
      column: 'intel-core-ultra/intel-npu',
      format: 'openvino',
      models: ['yolov9t-320', 'yolov9s-320'],
      currentTableRow: { state: 'measured' },
    })
    expect(JSON.stringify(view.describe)).toContain('detector-latency.json')
    expect(writes(hub.calls)).toEqual([])
  })

  it('dry run refuses a device that is not enabled (no token)', async () => {
    const s = script([], [npu({ enabled: false })])
    const dry = await supportBenchmarkRun(gatedHub(s.answers).ctx, s.deps, ARGS, undefined)
    expect(dryRunOf(dry).token).toBeUndefined()
    expect(JSON.stringify(dry)).toContain('not enabled')
  })

  it('dry run refuses while a node benchmark is running', async () => {
    const s = script([])
    const hub = gatedHub({
      ...s.answers,
      'pipelineOrchestrator.getNodeBenchmarkStatus': {
        run: { runId: 'r1', nodeId: 'hub', state: 'measuring' },
      },
    })
    const dry = await supportBenchmarkRun(hub.ctx, s.deps, ARGS, undefined)
    expect(dryRunOf(dry).token).toBeUndefined()
    expect(JSON.stringify(dry)).toContain('already measuring')
  })

  it('execute: warm median per model next to the table cell; a fully shed model is omitted, not a latency', async () => {
    const s = script([
      timing(50), // cold yolov9t-320
      timing(3.2),
      timing(2.8),
      timing(3.0),
      timing(80), // cold yolov9s-320
      { kind: 'shed' },
      { kind: 'shed' },
      timing(3100),
    ])
    const hub = gatedHub(s.answers)
    const token = dryRunOf(await supportBenchmarkRun(hub.ctx, s.deps, ARGS, undefined)).token
    const done = await supportBenchmarkRun(hub.ctx, s.deps, ARGS, token)
    if (done.status !== 'executed')
      throw new Error(`expected executed, got ${JSON.stringify(done)}`)
    expect(done.result).toMatchObject({
      column: 'intel-core-ultra/intel-npu',
      cells: { 'yolov9t-320': { p50Ms: 3, fps: 333, measured: true } },
      comparison: [
        {
          modelId: 'yolov9t-320',
          measuredP50Ms: 3,
          table: 'measured',
          tableP50Ms: 2.9,
          deltaPct: 3.4,
        },
      ],
      omitted: [{ modelId: 'yolov9s-320', status: 'shed' }],
    })
    expect(JSON.stringify(done.result)).toContain('support_draft_pr')
    // the pool is recycled once per model, and we waited for it each time
    expect(hub.calls.filter((c) => c.path === 'nodes.restartAddon')).toHaveLength(2)
    expect(s.sleeps).toEqual([123, 123])
    // 1 cold + 3 warm per model
    expect(hub.calls.filter((c) => c.path === 'addons.custom')).toHaveLength(8)
  })

  it('downloads a model that is not present for the device format before measuring it', async () => {
    const s = script([timing(9), timing(3), timing(3), timing(3)])
    const hub = gatedHub(s.answers)
    const args = { ...ARGS, models: ['yolov9m-320'] }
    const token = dryRunOf(await supportBenchmarkRun(hub.ctx, s.deps, args, undefined)).token
    await supportBenchmarkRun(hub.ctx, s.deps, args, token)
    expect(hub.calls.filter((c) => c.path === 'pipelineExecutor.downloadModel')).toHaveLength(1)
  })

  it('a model whose run throws is omitted as failed, the others still run', async () => {
    const s = script([new Error('SIGSEGV pool death'), timing(9), timing(3), timing(3), timing(3)])
    const hub = gatedHub(s.answers)
    const token = dryRunOf(await supportBenchmarkRun(hub.ctx, s.deps, ARGS, undefined)).token
    const done = await supportBenchmarkRun(hub.ctx, s.deps, ARGS, token)
    if (done.status !== 'executed') throw new Error('expected executed')
    expect(done.result).toMatchObject({
      omitted: [{ modelId: 'yolov9t-320', status: 'failed' }],
      cells: { 'yolov9s-320': { p50Ms: 3 } },
    })
  })

  it('a changed argument after the dry run burns the token (nothing is loaded)', async () => {
    const s = script([])
    const hub = gatedHub(s.answers)
    const token = dryRunOf(await supportBenchmarkRun(hub.ctx, s.deps, ARGS, undefined)).token
    const out = await supportBenchmarkRun(hub.ctx, s.deps, { ...ARGS, warmRuns: 9 }, token)
    expect(out).toMatchObject({ status: 'refused' })
    expect(writes(hub.calls)).toEqual([])
  })

  it('medianOf', () => {
    expect(medianOf([3, 1, 2])).toBe(2)
    expect(medianOf([4, 1, 2, 3])).toBe(2.5)
  })
})

describe('support_benchmark_status', () => {
  it('reports the run and the stored device cells, read-only', async () => {
    const { ctx, calls } = fakeHub({
      'pipelineOrchestrator.getNodeBenchmarkStatus': {
        run: {
          runId: 'r1',
          nodeId: 'hub',
          state: 'done',
          endReason: 'completed',
          error: null,
        },
      },
      'pipelineOrchestrator.listNodeBenchmarkResults': [
        {
          nodeId: 'hub',
          cell: {
            phase: 'device',
            deviceKey: 'openvino:npu',
            modelId: 'yolov9t-320',
            p50Ms: 3,
            fps: 300,
          },
        },
        {
          nodeId: 'hub',
          cell: {
            phase: 'pipeline',
            deviceKey: 'openvino:npu',
            modelId: 'x',
            maxSessions: 4,
          },
        },
      ],
    })
    const out = await supportBenchmarkStatus(ctx, {})
    expect(out).toMatchObject({
      status: 'ok',
      run: { state: 'done', endReason: 'completed' },
      storedResults: [{ deviceKey: 'openvino:npu', modelId: 'yolov9t-320', p50Ms: 3 }],
    })
    expect(writes(calls)).toEqual([])
  })

  it('an unreadable part is named, not zero', async () => {
    const { ctx } = fakeHub({
      'pipelineOrchestrator.getNodeBenchmarkStatus': new Error('boom'),
      'pipelineOrchestrator.listNodeBenchmarkResults': [],
    })
    const out = await supportBenchmarkStatus(ctx, {})
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable['run']).toContain('boom')
    expect(out.run).toBeNull()
  })
})
