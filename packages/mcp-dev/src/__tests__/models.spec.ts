import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HubClient } from '@camstack/develop'
import { requireWorkspaceRoot } from '@camstack/develop'
import { benchmarkRun, BenchmarkPlanSchema } from '../models/benchmark.js'
import { evalModel, type ProcessRunner } from '../models/eval.js'
import { fetchRetrainExport } from '../models/export.js'
import { modelFloors } from '../models/floors.js'
import { modelStudioImport } from '../models/studio-import.js'
import { MutationGate } from '../mutations/gate.js'
import { parseApiIndex } from '../ops/api-index.js'
import {
  createGatedHub,
  createGatedMutator,
  isRetrainExportPath,
  QueryRefusedError,
} from '../ops/hub.js'
import { birthDecisions, eventDensity } from '../ops/density.js'
import {
  PLAN,
  PREFLIGHT_BLOCKED,
  PREFLIGHT_OK,
  auditLog,
  fakeHub,
  fakeMutator,
} from './model-fakes.js'

const START = 'pipelineOrchestrator.startNodeBenchmark'
const PREFLIGHT = 'pipelineOrchestrator.getNodeBenchmarkPreflight'

function gateOf(allowMutations = true) {
  const audit = auditLog()
  let n = 0
  return {
    audit,
    gate: new MutationGate({ allowMutations, audit: audit.sink, newToken: () => `cfm_t${++n}` }),
  }
}

describe('benchmark_run — dry run, token, execute', () => {
  it('the dry run reads the preflight and NEVER calls the mutator', async () => {
    const { gate } = gateOf()
    const hub = fakeHub({ [PREFLIGHT]: PREFLIGHT_OK })
    const mutator = fakeMutator({ [START]: { kind: 'started', runId: 'r1' } })
    const r = await benchmarkRun({ gate, hub: () => hub, mutator: () => mutator }, PLAN, undefined)
    expect(r.status).toBe('dry-run')
    expect(JSON.stringify(r)).toMatch(/LOAD TEST/)
    expect(JSON.stringify(r)).toMatch(/confirm_token/)
    expect(mutator.calls).toHaveLength(0)
    expect(hub.queries.map((q) => q.path)).toEqual([PREFLIGHT])
  })

  it('does not issue a token when the hub preflight says canStart:false', async () => {
    const { gate } = gateOf()
    const hub = fakeHub({ [PREFLIGHT]: PREFLIGHT_BLOCKED })
    const mutator = fakeMutator()
    const r = await benchmarkRun({ gate, hub: () => hub, mutator: () => mutator }, PLAN, undefined)
    expect(r.status).toBe('dry-run')
    expect('confirm_token' in r).toBe(false)
    expect(JSON.stringify(r)).toMatch(/insufficient-headroom/)
  })

  it('the second call with the token starts exactly one run', async () => {
    const { gate } = gateOf()
    const hub = fakeHub({ [PREFLIGHT]: PREFLIGHT_OK })
    const mutator = fakeMutator({ [START]: { kind: 'started', runId: 'run-7' } })
    const deps = { gate, hub: () => hub, mutator: () => mutator }
    const dry = await benchmarkRun(deps, PLAN, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const done = await benchmarkRun(deps, PLAN, dry.confirm_token)
    expect(done).toMatchObject({ status: 'executed', result: { started: true, runId: 'run-7' } })
    expect(mutator.calls).toEqual([{ path: START, input: PLAN }])
    const replay = await benchmarkRun(deps, PLAN, dry.confirm_token)
    expect(replay.status).toBe('refused')
    expect(mutator.calls).toHaveLength(1)
  })

  it('refuses with the flag off before reading anything', async () => {
    const { gate } = gateOf(false)
    const hub = fakeHub({ [PREFLIGHT]: PREFLIGHT_OK })
    const mutator = fakeMutator()
    const r = await benchmarkRun({ gate, hub: () => hub, mutator: () => mutator }, PLAN, undefined)
    expect(r.status).toBe('refused')
    expect(hub.queries).toHaveLength(0)
    expect(mutator.calls).toHaveLength(0)
  })

  it('bounds one call: 4 devices, 60 minutes, 30 fps', () => {
    const base = { nodeId: 'n', devices: [{ deviceKey: 'd', modelIds: ['m'] }] }
    expect(BenchmarkPlanSchema.safeParse({ ...base, budgetMinutes: 61 }).success).toBe(false)
    expect(BenchmarkPlanSchema.safeParse({ ...base, fpsPerStream: 31 }).success).toBe(false)
    expect(
      BenchmarkPlanSchema.safeParse({ ...base, devices: Array(5).fill(base.devices[0]) }).success,
    ).toBe(false)
    expect(BenchmarkPlanSchema.safeParse({ ...base, budgetMinutes: 45 }).success).toBe(true)
  })
})

describe('model_studio_import', () => {
  const models = [
    {
      stepId: 'root',
      entry: { id: 'custom-640', name: 'Custom 640', formats: { onnx: {}, openvino: {} } },
    },
  ]
  const answers = {
    'customModelRegistry.listModels': models,
    'nodes.directory': {
      nodes: [
        { id: 'hub', isOnline: true },
        { id: 'mac', isOnline: true },
      ],
    },
  }
  const ACTION = 'addons.custom'

  it('a dry run describes the distribution and never mutates', async () => {
    const { gate } = gateOf()
    const hub = fakeHub(answers)
    const mutator = fakeMutator()
    const r = await modelStudioImport(
      { gate, hub: () => hub, mutator: () => mutator },
      { modelId: 'custom-640' },
      undefined,
    )
    expect(r.status).toBe('dry-run')
    expect(JSON.stringify(r)).toMatch(/ensureFormatsThenDistribute/)
    expect(JSON.stringify(r)).toMatch(/mac/)
    expect(mutator.calls).toHaveLength(0)
  })

  it('an unknown model is not confirmable', async () => {
    const { gate } = gateOf()
    const r = await modelStudioImport(
      { gate, hub: () => fakeHub(answers), mutator: () => fakeMutator() },
      { modelId: 'nope' },
      undefined,
    )
    expect('confirm_token' in r).toBe(false)
    expect(JSON.stringify(r)).toMatch(/does not upload|no such model/)
  })

  it('the confirmed call dispatches the one allow-listed model-studio action', async () => {
    const { gate } = gateOf()
    const hub = fakeHub(answers)
    const mutator = fakeMutator({ [ACTION]: { conversions: [], distributed: [] } })
    const deps = { gate, hub: () => hub, mutator: () => mutator }
    const dry = await modelStudioImport(deps, { modelId: 'custom-640' }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const done = await modelStudioImport(deps, { modelId: 'custom-640' }, dry.confirm_token)
    expect(done.status).toBe('executed')
    expect(mutator.calls).toEqual([
      {
        path: ACTION,
        input: {
          addonId: 'model-studio',
          action: 'ensureFormatsThenDistribute',
          input: { modelId: 'custom-640' },
        },
      },
    ])
  })
})

describe('the mutator allow-list (the last wall behind the gate)', () => {
  const INDEX = parseApiIndex(
    [
      '| `pipelineOrchestrator.startNodeBenchmark` | mutation | admin | pipeline-orchestrator |',
      '| `addons.custom` | mutation | protected | addons |',
      '| `nodes.restartNode` | mutation | admin | nodes |',
      '| `pipelineOrchestrator.getNodeBenchmarkStatus` | query | admin | pipeline-orchestrator |',
    ].join('\n'),
  )
  function mutatorWith(tier: 'admin' | 'protected') {
    const sent: { method: string; path: string; input: unknown }[] = []
    const client: HubClient = {
      async call(method, p, input) {
        sent.push({ method, path: p, input })
        return {}
      },
    }
    return {
      sent,
      mutator: createGatedMutator({ server: 'https://h.test', tier, index: INDEX, client }),
    }
  }

  it('refuses a mutation that is not allow-listed, even though it is a real one', async () => {
    const { sent, mutator } = mutatorWith('admin')
    await expect(mutator.mutate('nodes.restartNode', { nodeId: 'x' })).rejects.toThrow(
      QueryRefusedError,
    )
    await expect(mutator.mutate('made.up', {})).rejects.toThrow(/not an allow-listed/)
    expect(sent).toHaveLength(0)
  })

  it('refuses addons.custom for any addon or action but the Model Studio one', async () => {
    const { sent, mutator } = mutatorWith('admin')
    await expect(
      mutator.mutate('addons.custom', { addonId: 'terminal', action: 'run', input: {} }),
    ).rejects.toThrow(/model-studio/)
    await expect(
      mutator.mutate('addons.custom', {
        addonId: 'model-studio',
        action: 'removeCustomModel',
        input: {},
      }),
    ).rejects.toThrow(/not allow-listed/)
    expect(sent).toHaveLength(0)
  })

  it('refuses an admin-tier mutation on a protected credential', async () => {
    const { sent, mutator } = mutatorWith('protected')
    await expect(mutator.mutate('pipelineOrchestrator.startNodeBenchmark', {})).rejects.toThrow(
      /admin-tier/,
    )
    expect(sent).toHaveLength(0)
  })

  it('sends an allow-listed mutation as a POST', async () => {
    const { sent, mutator } = mutatorWith('admin')
    await mutator.mutate('pipelineOrchestrator.startNodeBenchmark', { nodeId: 'n' })
    expect(sent).toEqual([
      { method: 'POST', path: 'pipelineOrchestrator.startNodeBenchmark', input: { nodeId: 'n' } },
    ])
  })

  it('the read-only hub still refuses every mutation (P2 invariant)', async () => {
    const hub = createGatedHub({
      server: 'https://h.test',
      tier: 'admin',
      source: 'session',
      index: INDEX,
      client: { call: async () => ({}) },
    })
    await expect(hub.query('pipelineOrchestrator.startNodeBenchmark', {})).rejects.toThrow(
      /read-only/,
    )
  })
})

describe('download allow-list', () => {
  it('accepts only the retrain-export data-plane path', () => {
    expect(isRetrainExportPath('/addon/post-analysis/retrain-export?deviceIds=101')).toBe(true)
    expect(isRetrainExportPath('/addon/post-analysis/retrain-export')).toBe(true)
    expect(isRetrainExportPath('/addon/x/other-export')).toBe(false)
    expect(isRetrainExportPath('/trpc/keychain.reveal')).toBe(false)
    expect(isRetrainExportPath('https://evil.test/addon/x/retrain-export')).toBe(false)
    expect(isRetrainExportPath('/addon/../etc/retrain-export')).toBe(false)
  })

  it('a hub refuses a download outside the allow-list and for a protected credential', async () => {
    const make = (tier: 'admin' | 'protected') =>
      createGatedHub({
        server: 'https://h.test',
        tier,
        source: 'session',
        index: parseApiIndex(''),
        client: { call: async () => ({}) },
        downloader: async () => ({ bytes: 1 }),
      })
    await expect(make('admin').download('/trpc/x', '/tmp/x', 10)).rejects.toThrow(/allow-listed/)
    await expect(
      make('protected').download('/addon/a/retrain-export', '/tmp/x', 10),
    ).rejects.toThrow(/admin/)
    await expect(make('admin').download('/addon/a/retrain-export', '/tmp/x', 10)).resolves.toEqual({
      bytes: 1,
    })
  })
})

describe('model_floors', () => {
  const root = requireWorkspaceRoot()
  it('returns the measured row with the method and the decision', () => {
    const r = modelFloors(root, 'yolo26l-int8')
    expect(r.found).toBe(true)
    if (!r.found) return
    expect(r.table).toBe('detector')
    expect(JSON.stringify(r.floors)).toMatch(/"person"/)
    expect(JSON.stringify(r.method)).toMatch(/floor = lowest confidence/)
    expect(r.decision).toMatch(/D739/)
  })
  it('names near misses for an unknown model', () => {
    const r = modelFloors(root, 'yolo26')
    expect(r.found).toBe(false)
    if (r.found) return
    expect(r.nearest.length).toBeGreaterThan(0)
  })
})

describe('eval_model — workspace confinement and the venv', () => {
  let root: string
  const calls: { command: string; args: readonly string[] }[] = []
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args })
    const out = args.indexOf('--out')
    if (out >= 0) fs.writeFileSync(args[out + 1] ?? '', JSON.stringify({ ok: true, rows: [1] }))
    return { exitCode: 0, stdout: 'table\n', stderr: '' }
  }
  beforeEach(() => {
    calls.length = 0
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-root-'))
    fs.mkdirSync(path.join(root, 'scripts', 'eval'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'eval', 'requirements.txt'), 'numpy\n')
    fs.mkdirSync(path.join(root, 'scratchpad'), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const pair = (over: Record<string, unknown> = {}) => ({
    exportPath: 'scratchpad/ex.tar',
    baseline: 'scratchpad/b.onnx',
    baselineSize: 640,
    candidate: 'scratchpad/c.onnx',
    candidateSize: 640,
    ...over,
  })

  it('without a venv it answers with the commands and runs nothing', async () => {
    const r = await evalModel(root, pair(), { run })
    expect(r.status).toBe('needs-setup')
    expect(calls).toHaveLength(0)
  })

  it('refuses an input outside the workspace before creating anything', async () => {
    const r = await evalModel(root, pair({ candidate: '/etc/passwd', setupVenv: true }), { run })
    expect(r).toMatchObject({ status: 'refused' })
    expect(JSON.stringify(r)).toMatch(/outside the workspace/)
    expect(calls).toHaveLength(0)
    expect(fs.existsSync(path.join(root, 'scratchpad', 'eval'))).toBe(false)
  })

  it('refuses a symlink inside the workspace that points out of it', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-outside-'))
    fs.writeFileSync(path.join(outside, 'c.onnx'), 'x')
    fs.symlinkSync(outside, path.join(root, 'scratchpad', 'link'))
    const r = await evalModel(root, pair({ candidate: 'scratchpad/link/c.onnx' }), { run })
    expect(r).toMatchObject({ status: 'refused' })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('rejects mixed or missing modes', async () => {
    expect((await evalModel(root, { exportPath: 'scratchpad/ex.tar' }, { run })).status).toBe(
      'refused',
    )
    const r = await evalModel(
      root,
      pair({
        variants: [
          { label: 'a', path: 'scratchpad/a.onnx', size: 640 },
          { label: 'b', path: 'scratchpad/b.onnx', size: 640 },
        ],
      }),
      { run },
    )
    expect(r.status).toBe('refused')
  })

  it('runs evaluate.py with argv only, inside the venv, writing the report under scratchpad/eval', async () => {
    fs.mkdirSync(path.join(root, 'scratchpad', 'eval-venv', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scratchpad', 'eval-venv', 'bin', 'python'), '')
    const r = await evalModel(root, pair({ holdoutCameras: [101, 102] }), {
      run,
      now: () => new Date('2026-10-13T10:00:00Z'),
    })
    expect(r.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(path.join(root, 'scratchpad', 'eval-venv', 'bin', 'python'))
    expect(calls[0]?.args).toContain('--holdout-cameras')
    expect(calls[0]?.args).toContain('101,102')
    if (r.status !== 'done') return
    expect(r.reportPath).toMatch(/^scratchpad\/eval\/2026-10-13T10-00-00-000Z\/report\.json$/)
    expect(JSON.stringify(r.report)).toMatch(/rows/)
  })

  it('with setupVenv:true it creates the venv then installs the requirements', async () => {
    const r = await evalModel(root, pair({ setupVenv: true }), { run })
    expect(calls.slice(0, 2).map((c) => c.command)).toEqual([
      'python3',
      path.join(root, 'scratchpad', 'eval-venv', 'bin', 'pip'),
    ])
    expect(r.status === 'done' || r.status === 'failed').toBe(true)
  })
})

describe('fetch_retrain_export', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-root-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('asks the hub for the URL, then downloads into scratchpad/retrain-export', async () => {
    const hub = fakeHub({
      'pipelineAnalytics.getRetrainExportUrl': {
        url: '/addon/post-analysis/retrain-export?deviceIds=101',
      },
    })
    const r = await fetchRetrainExport(root, hub, {
      deviceIds: [101],
      completeOnly: true,
      name: 'ex1',
    })
    expect(r.path).toBe(path.join('scratchpad', 'retrain-export', 'ex1.tar'))
    expect(hub.queries[0]?.input).toEqual({ deviceIds: [101], completeOnly: true })
    expect(hub.downloads[0]?.destFile).toBe(path.join(root, r.path))
    expect(hub.downloads[0]?.maxBytes).toBe(2048 * 1024 * 1024)
  })

  it('never writes outside the workspace: a hostile name is refused by the schema, a symlinked dir by confinement', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'export-outside-'))
    fs.mkdirSync(path.join(root, 'scratchpad'))
    fs.symlinkSync(outside, path.join(root, 'scratchpad', 'retrain-export'))
    const hub = fakeHub({
      'pipelineAnalytics.getRetrainExportUrl': { url: '/addon/a/retrain-export' },
    })
    await expect(fetchRetrainExport(root, hub, { name: 'x' })).rejects.toThrow(
      /outside the workspace/,
    )
    expect(hub.downloads).toHaveLength(0)
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('birth_decisions and event_density', () => {
  it('aggregates the verdicts per class and the latency percentiles', async () => {
    const hub = fakeHub({
      'pipelineAnalytics.listBirthDecisions': [
        {
          id: '1',
          at: 1,
          deviceId: 101,
          className: 'person',
          verdict: 'confirmed',
          birthLatencyMs: 100,
        },
        {
          id: '2',
          at: 2,
          deviceId: 101,
          className: 'person',
          verdict: 'suppressed',
          reason: 'low',
        },
        {
          id: '3',
          at: 3,
          deviceId: 101,
          className: 'animal',
          verdict: 'confirmed',
          birthLatencyMs: 300,
        },
      ],
    })
    const out = JSON.stringify(await birthDecisions(hub, { deviceId: 101, hours: 2 }, 10_000_000))
    expect(out).toContain('"verdicts":{"confirmed":2,"suppressed":1}')
    expect(out).toContain('"person":{"confirmed":1,"suppressed":1}')
    expect(hub.queries[0]?.input).toMatchObject({
      deviceId: 101,
      since: 10_000_000 - 2 * 3_600_000,
    })
  })

  it('totals the buckets and names the busiest', async () => {
    const hub = fakeHub({
      'pipelineAnalytics.getEventDensity': [
        { bucketStart: 0, motion: 1, object: 2, audio: 0 },
        { bucketStart: 1, motion: 10, object: 5, audio: 1 },
      ],
    })
    const out = (await eventDensity(
      hub,
      { deviceId: 101, hours: 2, bucketMinutes: 60 },
      7_200_000,
    )) as {
      totals: { motion: number; object: number; audio: number }
      busiest: { bucketStart: number }[]
    }
    expect(out.totals).toEqual({ motion: 11, object: 7, audio: 1 })
    expect(out.busiest[0]?.bucketStart).toBe(1)
  })
})
