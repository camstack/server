/**
 * The training job state machine against the fake provider (D805).
 *
 * Pinned, one test each: an idempotent start; a retried submit never starts
 * a second GPU; the happy path ends `ready` with the cloud copy deleted; a
 * restart mid-upload fails BY NAME and cleans up while a running job is
 * re-attached; the cost cap cancels; a bundle that is not the one result.json
 * names is refused; a failed job keeps its cloud dataset for the grace period
 * and no longer; the orphan sweep stops a cloud job we hold no record of;
 * expired artefacts leave the hub; a dataset with nothing left to train on is
 * refused before anything is uploaded.
 */
import { describe, expect, it } from 'vitest'
import { SETTLED, TrainingEngine } from '../orchestrator/job-engine.js'
import { corpusStats, fakeResult, harness, TRAINER } from './harness.js'

const REQUEST = {
  selection: { collectionIds: ['col-1'], workState: 'complete' as const },
  entryId: 'fake-default',
  gpuType: 'L4',
  region: '',
  baseModelId: 'yolov9m-640',
  preset: 'standard' as const,
  freeze: null,
  holdoutCameras: null,
  name: 'night fix',
  maxCostUsd: 3,
  maxRuntimeSec: 4 * 3600,
  idempotencyKey: 'idem-0001',
}

async function startedJobId(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const started = await h.engine.startJob(REQUEST)
  if (started.kind !== 'started') throw new Error(`refused: ${started.reason}`)
  await h.engine.settle()
  return started.job.id
}

describe('training job engine', () => {
  it('returns the same job for the same idempotency key', async () => {
    const h = await harness()
    const a = await h.engine.startJob(REQUEST)
    const b = await h.engine.startJob(REQUEST)
    expect(a.kind === 'started' && b.kind === 'started' && a.job.id === b.job.id).toBe(true)
    await h.engine.settle()
    expect(h.provider.calls.filter((c) => c.startsWith('submit:'))).toHaveLength(1)
  })

  it('uploads the resolved frames, submits a valid job.json and polls into running', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    const cloud = h.provider.jobs.get(id)
    expect(cloud?.dataset?.bytes).toBeGreaterThan(0)
    const spec = JSON.parse(cloud?.jobSpecJson ?? '{}')
    expect(spec.dataset.sha256).toBe(cloud?.dataset?.sha256)
    expect(spec.split.holdoutCameras).toEqual([102, 108])
    expect((await h.jobs.get(id))?.state).toBe('submitted')
    h.provider.advance(id, 'running')
    h.provider.emit(id, 'CAMSTACK_EVENT {"v":1,"ts":1,"type":"stage","stage":"train"}')
    h.provider.emit(
      id,
      'CAMSTACK_EVENT {"v":1,"ts":2,"type":"epoch","epoch":1,"epochs":40,"map50":0.4,"map50_95":0.2}',
    )
    await h.engine.tick()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('running')
    expect(job?.stage).toBe('train')
    expect(job?.progress.series).toEqual([{ epoch: 1, map50: 0.4, map50_95: 0.2 }])
    expect(job?.logTail).toHaveLength(2)
  })

  it('a retried submit for the same job key starts no second GPU', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    await h.provider.submitJob({
      entryId: h.provider.defaultEntryId,
      jobKey: id,
      jobSpecJson: '{}',
      gpuType: 'L4',
    })
    expect(h.provider.jobs.get(id)?.submits).toBe(2)
    expect([...h.provider.jobs.keys()]).toEqual([id])
  })

  it('collects a verified result, ends ready, and deletes the cloud copy', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.advance(id, 'running')
    h.provider.finish(id, fakeResult(h.provider.jobs.get(id)?.jobSpecJson ?? ''))
    h.provider.advance(id, 'succeeded')
    await h.engine.tick()
    await h.engine.settle()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('ready')
    expect(job?.artifacts?.bundleBytes).toBeGreaterThan(0)
    expect(job?.cloudDatasetDeletedAt).not.toBeNull()
    expect(h.provider.jobs.get(id)?.datasetDeleted).toBe(true)
    expect(h.artifacts.results.has(id)).toBe(true)
  })

  it('refuses a bundle that is not the one result.json names', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    const good = fakeResult(h.provider.jobs.get(id)?.jobSpecJson ?? '')
    h.provider.finish(id, { resultText: good.resultText, bundle: Buffer.from('something else!!') })
    h.provider.advance(id, 'succeeded')
    await h.engine.tick()
    await h.engine.settle()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('failed')
    expect(job?.failure?.reason).toBe('checksum-mismatch')
    expect(h.artifacts.bundles.has(id)).toBe(false)
  })

  it('cancels at the cost cap', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.advance(id, 'running')
    h.provider.setCost(id, 3.01)
    await h.engine.tick()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('failed')
    expect(job?.failure?.reason).toBe('cost-cap')
    expect(h.provider.calls).toContain(`cancel:${id}`)
  })

  it('keeps a failed job dataset for the grace period, then deletes it', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.advance(id, 'failed', 70)
    await h.engine.tick()
    expect((await h.jobs.get(id))?.failure?.reason).toBe('trainer-failed')
    await h.engine.tick()
    expect(h.provider.jobs.get(id)?.datasetDeleted).toBe(false)
    h.clock.now += 24 * 3600_000 + 1
    await h.engine.tick()
    expect(h.provider.jobs.get(id)?.datasetDeleted).toBe(true)
  })

  it('after a restart: an interrupted upload fails by name, a running job is re-attached', async () => {
    const h = await harness()
    const runningId = await startedJobId(h)
    h.provider.advance(runningId, 'running')
    const now = h.clock.now
    await h.jobs.put({
      ...(await h.jobs.get(runningId))!,
      id: 'uploading-1',
      idempotencyKey: 'idem-9',
      state: 'uploading',
      createdAt: now - 1,
    })
    const restarted = new TrainingEngine(h.ports, TRAINER)
    await restarted.tick()
    const interrupted = await h.jobs.get('uploading-1')
    expect(interrupted?.state).toBe('failed')
    expect(interrupted?.failure?.reason).toBe('hub-restart-during-upload')
    expect((await h.jobs.get(runningId))?.state).toBe('running')
  })

  it('cancels a job and cleans the cloud up once the provider stops it', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.advance(id, 'running')
    expect((await h.engine.cancelJob(id)).state).toBe('cancelling')
    await h.engine.tick()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('cancelled')
    expect(job?.cloudDatasetDeletedAt).not.toBeNull()
  })

  it('marks a job the provider forgot as lost', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.forget(id)
    await h.engine.tick()
    expect((await h.jobs.get(id))?.state).toBe('lost')
  })

  it('sweeps a cloud job we hold no record of', async () => {
    const h = await harness()
    h.provider.plantOrphan('11111111-1111-4111-8111-111111111111')
    const swept = await h.engine.sweepOrphans()
    expect(swept).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(h.provider.jobs.get('11111111-1111-4111-8111-111111111111')?.state).toBe('cancelled')
  })

  it('removes expired artefacts and marks an unregistered result expired', async () => {
    const h = await harness()
    const id = await startedJobId(h)
    h.provider.finish(id, fakeResult(h.provider.jobs.get(id)?.jobSpecJson ?? ''))
    h.provider.advance(id, 'succeeded')
    await h.engine.tick()
    await h.engine.settle()
    h.clock.now += 15 * 24 * 3600_000
    await h.engine.tick()
    const job = await h.jobs.get(id)
    expect(job?.state).toBe('expired')
    expect(job?.artifacts).toBeNull()
    expect(h.artifacts.bundles.has(id)).toBe(false)
  })

  it('refuses a corpus with nothing left to train on, before any upload', async () => {
    const h = await harness()
    h.corpus.byCollection.set('col-thin', {
      kind: 'resolved',
      frameIds: Array.from({ length: 50 }, (_, i) => `t${String(i)}`),
      stats: corpusStats({ subjects: 150 }),
      annotationHash: 'hash-thin',
      layout: 'frames',
    })
    h.corpus.known.add('col-thin')
    const started = await h.engine.startJob({
      ...REQUEST,
      selection: { collectionIds: ['col-thin'], workState: 'complete' },
      idempotencyKey: 'idem-thin',
    })
    expect(started.kind === 'refused' && started.reason).toBe('no-training-subjects')
    expect(h.provider.calls).toEqual([])
  })

  it('snapshots selection and frameCount on a started job', async () => {
    const h = await harness()
    const started = await h.engine.startJob(REQUEST)
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    expect(started.job.request.selection).toEqual({
      collectionIds: ['col-1'],
      workState: 'complete',
    })
    expect(started.job.frameCount).toBe(300)
    expect(started.job.frameIds).toHaveLength(300)
    await h.engine.settle()
  })

  it('refuses a second job while one holds a GPU', async () => {
    const h = await harness()
    await startedJobId(h)
    const second = await h.engine.startJob({ ...REQUEST, idempotencyKey: 'idem-0002' })
    expect(second.kind === 'refused' && second.reason).toBe('job-already-running')
  })

  it('refuses start while only queued batch siblings remain (no ACTIVE)', async () => {
    const h = await harness()
    const started = await h.engine.startJobBatch({
      ...REQUEST,
      baseModelIds: ['yolov9m-640', 'yolov9s-640', 'yolov9t-640'],
      idempotencyKey: 'idem-batch-queued-busy',
    })
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    await h.engine.settle()

    const rows = [...(await h.jobs.list())].toSorted((a, b) => a.createdAt - b.createdAt)
    const head = rows[0]
    expect(head).toBeDefined()
    if (head === undefined) return
    // Gap after the head settles and before advanceBatchQueue promotes the next sibling.
    await h.jobs.put({ ...head, state: 'ready', updatedAt: h.clock.now })

    const after = await h.jobs.list()
    expect(after.every((j) => SETTLED.has(j.state) || j.state === 'queued')).toBe(true)
    expect(after.filter((j) => j.state === 'queued')).toHaveLength(2)

    const concurrent = await h.engine.startJob({
      ...REQUEST,
      idempotencyKey: 'idem-during-queue-gap',
    })
    expect(concurrent.kind === 'refused' && concurrent.reason).toBe('job-already-running')

    const concurrentBatch = await h.engine.startJobBatch({
      ...REQUEST,
      baseModelIds: ['yolov9m-640', 'yolov9s-640'],
      idempotencyKey: 'idem-batch-during-queue-gap',
    })
    expect(concurrentBatch.kind === 'refused' && concurrentBatch.reason).toBe('job-already-running')
  })

  it('enqueues a sequential multi-model batch: three rows, one active until advanced', async () => {
    const h = await harness()
    const models = ['yolov9m-640', 'yolov9s-640', 'yolov9t-640'] as const
    const started = await h.engine.startJobBatch({
      ...REQUEST,
      baseModelIds: [...models],
      idempotencyKey: 'idem-batch-1',
    })
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    expect(started.jobs).toHaveLength(3)
    expect(started.batchId.length).toBeGreaterThan(0)
    await h.engine.settle()

    const rows = [...(await h.jobs.list())].toSorted((a, b) => a.createdAt - b.createdAt)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((j) => j.batchId))).toEqual(new Set([started.batchId]))
    expect(rows.map((j) => j.request.baseModelId)).toEqual([...models])

    const activeNow = (): number =>
      rows.filter((j) => !SETTLED.has(j.state) && j.state !== 'queued').length

    const refresh = async (): Promise<void> => {
      const latest = await h.jobs.list()
      for (const row of rows) {
        const next = latest.find((j) => j.id === row.id)
        if (next !== undefined) Object.assign(row, next)
      }
    }

    await refresh()
    expect(activeNow()).toBe(1)
    expect(rows.filter((j) => j.state === 'queued')).toHaveLength(2)
    expect(rows[0]?.state).not.toBe('queued')

    const unrelated = await h.engine.startJob({ ...REQUEST, idempotencyKey: 'idem-parallel' })
    expect(unrelated.kind === 'refused' && unrelated.reason).toBe('job-already-running')

    for (let i = 0; i < models.length; i += 1) {
      await refresh()
      expect(activeNow()).toBe(1)
      const current = rows.find((j) => !SETTLED.has(j.state) && j.state !== 'queued')
      expect(current).toBeDefined()
      if (current === undefined) return
      expect(current.request.baseModelId).toBe(models[i])
      h.provider.finish(current.id, fakeResult(h.provider.jobs.get(current.id)?.jobSpecJson ?? ''))
      h.provider.advance(current.id, 'succeeded')
      await h.engine.tick()
      await h.engine.settle()
      await refresh()
      expect(current.state).toBe('ready')
      expect(rows.filter((j) => j.state === 'queued')).toHaveLength(
        Math.max(0, models.length - i - 2),
      )
    }

    await refresh()
    expect(rows.every((j) => j.state === 'ready')).toBe(true)
    expect(activeNow()).toBe(0)
  })
})
