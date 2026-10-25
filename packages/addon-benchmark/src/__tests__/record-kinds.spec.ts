import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { EvalRunBody, EvalSampleBody } from '../benchmark-schemas.js'
import { benchmarkRecordKinds } from '../record-kinds.js'

const RUN: EvalRunBody = {
  datasetSource: 'retrain',
  datasetId: 'retrain-1',
  annotationHash: 'sha256:abc',
  nodeId: 'hub',
  deviceKey: 'openvino:npu',
  modelId: 'yolov9m-640',
  secondPass: true,
  state: 'queued',
  progress: { done: 0, failed: 0, total: 2 },
  summary: null,
  error: null,
  isReference: false,
  createdAt: 1_000,
}

const sampleOf = (sampleId: string): EvalSampleBody => ({
  runId: 'run-1',
  sampleId,
  ok: false,
  refusal: 'model-not-servable: asked yolov9m-640, ran yolov9s-320',
  full: [],
  final: [],
  recipe: null,
  timings: {
    fullStepMs: null,
    fullPredictMs: null,
    fullWallMs: null,
    frameStepMs: null,
    cropStepMs: [],
  },
  flooredCount: 0,
})

describe('benchmark record kinds', () => {
  it('declares eval-run and eval-sample, both owner-swept, off the settings thread', () => {
    const run = benchmarkRecordKinds['eval-run']
    const sample = benchmarkRecordKinds['eval-sample']
    expect(run.name).toBe('eval-run')
    expect(sample.name).toBe('eval-sample')
    for (const kind of [run, sample]) {
      expect(kind.declaration.database).toBe('events')
      expect(kind.declaration.retention).toMatchObject({ owner: 'benchmark' })
    }
  })

  it('an engine accepts the declarations; runs list per dataset×device, samples per run', async () => {
    const world = makeInMemoryRecords('benchmark')
    await world.records.declare(benchmarkRecordKinds)
    const runs = world.records.kind(benchmarkRecordKinds['eval-run'])
    const samples = world.records.kind(benchmarkRecordKinds['eval-sample'])
    await runs.put({ id: 'run-1', at: RUN.createdAt, data: RUN })
    await runs.put({ id: 'run-2', at: 2_000, data: { ...RUN, deviceKey: 'coreml:all' } })
    await samples.put({ id: 'run-1:a', data: sampleOf('a') })
    await samples.put({ id: 'run-1:b', data: sampleOf('b') })

    const page = await runs.query({ where: { datasetId: 'retrain-1', deviceKey: 'openvino:npu' } })
    expect(page.records.map((r) => r.id)).toEqual(['run-1'])
    const owned = await samples.query({ where: { runId: 'run-1' } })
    expect(owned.records.map((r) => r.data.sampleId)).toEqual(['a', 'b'])
  })

  it('one sample per (run, sample): a second row for the same pair is refused', async () => {
    const world = makeInMemoryRecords('benchmark')
    await world.records.declare(benchmarkRecordKinds)
    const samples = world.records.kind(benchmarkRecordKinds['eval-sample'])
    await samples.put({ id: 'run-1:a', data: sampleOf('a') })
    await expect(samples.put({ id: 'dup', data: sampleOf('a') })).rejects.toThrow()
  })
})
