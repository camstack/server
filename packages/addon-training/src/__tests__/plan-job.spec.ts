/**
 * Live corpus selection on plan: unknown collections and empty complete sets
 * refuse before any provider estimate; a happy path accepts the snapshot.
 */
import { describe, expect, it } from 'vitest'
import { planJob } from '../orchestrator/plan-job.js'
import { corpusStats, harness, MemoryCorpusPort } from './harness.js'

const BASE_REQUEST = {
  selection: { collectionIds: ['col-1'], workState: 'complete' as const },
  entryId: 'fake-default',
  gpuType: 'L4',
  region: '',
  baseModelId: 'yolov9m-640',
  preset: 'standard' as const,
  freeze: null,
  holdoutCameras: null,
}

describe('planJob live corpus selection', () => {
  it('refuses an unknown collection as unknown-dataset', async () => {
    const h = await harness()
    const planned = await planJob(
      { ...BASE_REQUEST, selection: { collectionIds: ['missing'], workState: 'complete' } },
      { corpus: h.corpus, provider: h.provider },
    )
    expect(planned.plan.refusal?.reason).toBe('unknown-dataset')
    expect(planned.accepted).toBeNull()
  })

  it('refuses an empty complete set as no-training-subjects', async () => {
    const corpus = new MemoryCorpusPort()
    corpus.byCollection.set('col-1', {
      kind: 'refused',
      reason: 'no-frames',
      detail: 'no frames match the selected collections and work-state rule',
    })
    const h = await harness()
    const planned = await planJob(BASE_REQUEST, { corpus, provider: h.provider })
    expect(planned.plan.refusal?.reason).toBe('no-training-subjects')
    expect(planned.accepted).toBeNull()
  })

  it('accepts a resolved selection and snapshots frame count', async () => {
    const h = await harness()
    const planned = await planJob(BASE_REQUEST, { corpus: h.corpus, provider: h.provider })
    expect(planned.plan.refusal).toBeNull()
    expect(planned.accepted?.corpus.frameIds).toHaveLength(300)
    expect(planned.accepted?.corpus.stats).toEqual(corpusStats())
    expect(planned.plan.split?.trainSubjects).toBeGreaterThan(0)
  })
})
