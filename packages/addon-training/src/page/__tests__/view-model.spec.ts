/**
 * The Training page's view-model: pure functions from job/result records to
 * what the page draws. Pinned: the timeline marks done / current / failed
 * correctly (a failure is shown where it happened, never as "ready"); polling
 * runs only while a job can still move; money and durations format honestly
 * (an estimate says so); the comparison table carries baseline / candidate /
 * INT8 per class and colours a per-camera recall drop past 0.01 as worse.
 */
import type { TrainingJob, TrainingResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  comparisonRows,
  formatCost,
  formatDuration,
  isSettled,
  recallDeltaRows,
  shouldPoll,
  timelineSteps,
} from '../view-model.js'

function job(overrides: Partial<TrainingJob>): TrainingJob {
  return {
    id: 'j1',
    idempotencyKey: 'k',
    name: 'n',
    createdAt: 0,
    updatedAt: 0,
    state: 'running',
    batchId: null,
    stage: 'train',
    failure: null,
    request: {
      selection: { collectionIds: ['col-1'], workState: 'complete' },
      entryId: 'modal-entry-default',
      gpuType: 'L4',
      region: '',
      baseModelId: 'yolov9m-640',
      preset: 'standard',
      freeze: null,
      holdoutCameras: null,
    },
    maxCostUsd: 3,
    maxRuntimeSec: 3600,
    trainer: { repo: 'r', revision: 'abcdef1' },
    datasetLayout: 'frames',
    frameCount: 10,
    frameIds: ['f0'],
    annotationHash: 'h',
    dataset: null,
    split: { holdoutCameras: [], holdoutLastDays: 3, holdoutSupport: null, trainSubjects: 1 },
    provider: {
      state: 'running',
      providerJobId: 'p',
      startedAt: 1000,
      endedAt: null,
      billedSeconds: 0,
      costUsd: 0.42,
      costIsEstimate: true,
      lastPolledAt: null,
    },
    progress: { epoch: null, epochs: null, etaSec: null, series: [] },
    logTail: [],
    logCursor: null,
    artifacts: null,
    cloudDatasetDeletedAt: null,
    cloudCleanupDueAt: null,
    registeredModelIds: [],
    canary: null,
    ...overrides,
  }
}

describe('timelineSteps', () => {
  it('marks the steps before the current state done and the current one current', () => {
    const steps = timelineSteps(job({ state: 'running' }))
    expect(steps.map((s) => s.status).slice(0, 5)).toEqual([
      'done',
      'done',
      'done',
      'current',
      'todo',
    ])
  })

  it('shows a failure where it happened, not as a later state', () => {
    const steps = timelineSteps(
      job({
        state: 'failed',
        provider: { ...job({}).provider, state: 'running' },
        failure: { reason: 'cost-cap', stage: 'train', detail: 'x' },
      }),
    )
    expect(steps.find((s) => s.status === 'failed')?.state).toBe('running')
    expect(steps.some((s) => s.state === 'ready' && s.status !== 'todo')).toBe(false)
  })

  it('a failure before anything was submitted sits on the upload', () => {
    const steps = timelineSteps(
      job({
        state: 'failed',
        provider: { ...job({}).provider, state: null },
        failure: { reason: 'upload-failed', stage: 'prepare', detail: 'x' },
      }),
    )
    expect(steps.find((s) => s.status === 'failed')?.state).toBe('uploading')
  })
})

describe('polling', () => {
  it('polls only while a job can still move', () => {
    expect(shouldPoll([job({ state: 'ready' }), job({ state: 'failed' })])).toBe(false)
    expect(shouldPoll([job({ state: 'ready' }), job({ state: 'collecting' })])).toBe(true)
    expect(isSettled('canary')).toBe(true)
    expect(isSettled('cancelling')).toBe(false)
  })
})

describe('formatting', () => {
  it('says when a cost is an estimate', () => {
    expect(formatCost(0.4234, true)).toBe('≈ $0.42')
    expect(formatCost(1.5, false)).toBe('$1.50')
  })

  it('formats durations in the largest useful unit', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(125)).toBe('2 min 5 s')
    expect(formatDuration(3 * 3600 + 120)).toBe('3 h 2 min')
  })
})

const cls = (recall: number) => ({
  positives: 30,
  floor: 0.5,
  tp: 20,
  fp: 2,
  fn: 10,
  precision: 0.9,
  recall,
  ap50: 0.8,
  recallByLight: { day: recall, night: recall - 0.1 },
  smallFound: 3,
  smallTotal: 6,
})

function result(): TrainingResult {
  return {
    schema: 'camstack.training-result/v1',
    jobKey: 'j1',
    status: 'succeeded',
    error: null,
    trainer: { version: '0.1.0', revision: 'abcdef1' },
    toolchain: {},
    evaluation: {
      holdoutFrames: 60,
      baseline: { frames: 60, classes: { person: cls(0.7) } },
      candidate: { frames: 60, classes: { person: cls(0.8) } },
      candidateInt8: null,
      recallDeltaByCamera: { person: { '101': 0.05, '102': -0.02, '108': -0.005 } },
      map50: { candidate: 0.7, candidateInt8: null },
    },
    licence: 'AGPL',
  }
}

describe('comparison', () => {
  it('builds one row per class with baseline and candidate side by side', () => {
    const rows = comparisonRows(result())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cls).toBe('person')
    expect(rows[0]?.baseline?.recall).toBe(0.7)
    expect(rows[0]?.candidate?.recall).toBe(0.8)
    expect(rows[0]?.int8).toBeNull()
  })

  it('colours a per-camera recall drop past 0.01 as worse', () => {
    const rows = recallDeltaRows(result())
    expect(rows.map((r) => [r.deviceId, r.tone])).toEqual([
      [101, 'better'],
      [102, 'worse'],
      [108, 'same'],
    ])
  })
})
