/**
 * The Node benchmark editor (D791): every choice reaches the plan, the
 * confirmation names the node, the cameras that move and those that cannot,
 * the steps and the duration, and a stored result reads as one row.
 */
import type {
  NodeBenchmarkCandidates,
  NodeBenchmarkPreflight,
  NodeBenchmarkResultView,
  NodeBenchmarkRun,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  initialDraft,
  planOf,
  preflightLines,
  resultRow,
  runLine,
  toggleDevice,
  toggleModel,
  togglePhase,
  toggleStep,
} from '../plan-editor.js'

const CANDIDATES: NodeBenchmarkCandidates = {
  nodeId: 'mac',
  reachable: true,
  devices: [
    {
      deviceKey: 'coreml:all',
      enabled: true,
      available: true,
      suggested: ['yolov9m-640', 'yolov9s-640'],
      all: ['yolov9m-640', 'yolov9s-640', 'yolov9t-320'],
      currentModelId: 'yolov9m-640',
    },
    {
      deviceKey: 'cpu',
      enabled: false,
      available: true,
      suggested: ['yolov9t-320'],
      all: ['yolov9t-320'],
      currentModelId: null,
    },
  ],
  steps: [{ id: 'face-detection', name: 'Faces', slot: 'cropper' }],
}

describe('plan editor', () => {
  it('starts from the enabled devices with their first suggestion', () => {
    const plan = planOf(initialDraft(CANDIDATES))
    expect(plan).toEqual({
      kind: 'plan',
      plan: {
        nodeId: 'mac',
        devices: [{ deviceKey: 'coreml:all', modelIds: ['yolov9m-640'] }],
        phases: ['device', 'pipeline'],
        steps: [],
        fpsPerStream: 10,
        budgetMinutes: 45,
        keepDownloadedModels: false,
        acceptInsufficientHeadroom: false,
      },
    })
  })

  it('every toggle reaches the plan, in the order picked', () => {
    let d = initialDraft(CANDIDATES)
    d = toggleModel(d, 'coreml:all', 'yolov9t-320')
    d = toggleDevice(d, 'cpu')
    d = toggleStep(d, 'face-detection')
    const plan = planOf(d)
    expect(plan.kind === 'plan' && plan.plan.devices).toEqual([
      { deviceKey: 'coreml:all', modelIds: ['yolov9m-640', 'yolov9t-320'] },
      { deviceKey: 'cpu', modelIds: ['yolov9t-320'] },
    ])
    expect(plan.kind === 'plan' && plan.plan.steps).toEqual(['face-detection'])
  })

  it('steps are dropped when the pipeline measurement is off', () => {
    const d = togglePhase(toggleStep(initialDraft(CANDIDATES), 'face-detection'), 'pipeline')
    const plan = planOf(d)
    expect(plan.kind === 'plan' && plan.plan.steps).toEqual([])
    expect(plan.kind === 'plan' && plan.plan.phases).toEqual(['device'])
  })

  it('an empty selection is not a plan, and says why', () => {
    const d = toggleModel(initialDraft(CANDIDATES), 'coreml:all', 'yolov9m-640')
    expect(planOf(d)).toEqual({ kind: 'incomplete', why: 'Choose at least one device and model.' })
    const none = togglePhase(togglePhase(initialDraft(CANDIDATES), 'device'), 'pipeline')
    expect(planOf(none).kind).toBe('incomplete')
  })
})

describe('confirmation', () => {
  const pf: NodeBenchmarkPreflight = {
    nodeId: 'mac',
    online: true,
    moving: [
      { deviceId: 12, placedOnNode: true, pinnedToNode: false },
      { deviceId: 14, placedOnNode: false, pinnedToNode: true },
    ],
    staying: [{ deviceId: 20, reason: 'only-frame-source' }],
    estimatedDurationMs: 25 * 60_000,
    budgetMs: 45 * 60_000,
    phases: ['device', 'pipeline'],
    steps: ['face-detection'],
    devices: [{ deviceKey: 'coreml:all', modelIds: ['yolov9m-640'] }],
    headroom: { sessionsNow: 1, otherNodesCapacitySessions: 8 },
    refusals: [],
    canStart: true,
  }
  it('names the node, the cameras that move, the ones that cannot, steps and duration', () => {
    const text = preflightLines(pf).join('\n')
    expect(text).toContain('mac')
    expect(text).toContain('#12, #14 (pinned here — the pin is restored after)')
    expect(text).toContain('#20')
    expect(text).toContain('contaminated')
    expect(text).toContain('face-detection')
    expect(text).toContain('25 min')
    expect(text).toContain('45 min')
  })
})

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(40_000)).toBe('40 s')
    expect(formatDuration(12 * 60_000)).toBe('12 min')
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min')
  })

  it('a run line says what happens and how it ended', () => {
    const base: NodeBenchmarkRun = {
      runId: 'r',
      nodeId: 'mac',
      state: 'aborted',
      plan: {
        nodeId: 'mac',
        devices: [{ deviceKey: 'x', modelIds: ['m'] }],
        phases: ['device'],
        steps: [],
        fpsPerStream: 10,
        budgetMinutes: 45,
        keepDownloadedModels: false,
        acceptInsufficientHeadroom: false,
      },
      startedAtMs: 0,
      deadlineAtMs: 1,
      finishedAtMs: 1,
      endReason: 'hub-restart',
      error: null,
      moved: [],
      staying: [],
      contaminated: false,
      progress: null,
      resultIds: [],
    }
    expect(runLine(base)).toContain('the hub restarted')
    expect(runLine({ ...base, state: 'draining' })).toContain('Moving cameras off mac')
  })

  it('a result row carries capacity, standing and flags', () => {
    const view: NodeBenchmarkResultView = {
      id: 'r:0',
      runId: 'r',
      nodeId: 'hub',
      cell: {
        phase: 'pipeline',
        deviceKey: 'openvino:npu',
        modelId: 'yolov9s-640',
        steps: ['face-detection'],
        maxSessions: 6,
        limitedBy: 'cpu',
        stepsFired: ['face-detection'],
        warmupMs: 0,
        ramp: [],
      },
      fpsPerStream: 10,
      fingerprint: null,
      clip: { id: 'reference-images', revision: null, frames: 8, width: 640, height: 360 },
      contaminated: true,
      stayingCameras: [],
      partialRun: false,
      measuredAtMs: 0,
      standing: 'stale',
      staleWhy: 'runtime',
    }
    const row = resultRow(view, 'en-GB')
    expect(row.capacity).toBe('6 sessions')
    expect(row.standing).toContain('runtime changed')
    expect(row.flags).toEqual(['contaminated', 'reference images'])
  })
})
