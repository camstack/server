import { HubRpcError } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import { applyPlan, ApplyPlanSchema, type ApplyPlan } from '../apply.js'
import { annotation, FakeHub, frameFor } from './fixtures.js'

const PLAN: ApplyPlan = ApplyPlanSchema.parse({
  tracks: [
    {
      trackId: 't1',
      deviceId: 1,
      verdict: 'wrong-class',
      subjects: [{ boxOf: 't1', macroClass: 'animal', label: 'dog' }],
      markComplete: true,
    },
  ],
})
const GO = { confirm: true, collectionName: 'review-a', overwrite: false }

describe('applyPlan confirm gate', () => {
  it('sends nothing — not even a read — without confirm', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(hub, PLAN, { ...GO, confirm: false })
    expect(r.refused).toContain('confirm')
    expect(hub.calls).toEqual([])
  })

  it('refuses a blank collection name before any call', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(hub, PLAN, { ...GO, collectionName: '   ' })
    expect(r.refused).toContain('collection name')
    expect(hub.calls).toEqual([])
  })
})

describe('applyPlan collection name resolution', () => {
  const NAMELESS = { confirm: true, overwrite: false }

  it('uses plan.collectionName when the argument is absent', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(hub, { ...PLAN, collectionName: 'from-plan' }, NAMELESS)
    expect(r.collection?.name).toBe('from-plan')
  })

  it('lets the argument win when both are given', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(
      hub,
      { ...PLAN, collectionName: 'from-plan' },
      { ...NAMELESS, collectionName: 'from-arg' },
    )
    expect(r.collection?.name).toBe('from-arg')
  })

  it('refuses, with no call, when neither names a collection', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(hub, PLAN, NAMELESS)
    expect(r.refused).toContain('collection name')
    expect(hub.calls).toEqual([])
  })
})

describe('applyPlan writes', () => {
  it('runs the full sequence once and reports the corpus KPI before and after', async () => {
    const hub = new FakeHub()
    const r = await applyPlan(hub, PLAN, GO)
    expect(r.tracks[0]).toMatchObject({ trackId: 't1', outcome: 'done' })
    expect(hub.writes).toEqual([
      'createCollection',
      'setTrackFlags',
      'selectRetrainFrames',
      'saveRetrainAnnotations',
      'setRetrainFrameComplete',
      'addFramesToCollection',
    ])
    expect(hub.saved[0]!.annotations).toEqual([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        macroClass: 'animal',
        label: 'dog',
        kind: 'subject',
        // The pipeline drew this box: provenance says so, and the snapshot it
        // was offered as survives the reviewer's relabel (cat -> dog).
        source: 'pipeline',
        origin: {
          source: 'pipeline',
          ref: 'pipeline:t1',
          bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          macroClass: 'animal',
          label: 'cat',
        },
      },
    ])
    expect(r.kpiBefore).toBeDefined()
    expect(r.kpiAfter).toBeDefined()
  })

  it('keeps the model and score of a pipeline box, never mislabelled as the operator', async () => {
    const hub = new FakeHub({
      copies: {
        t1: frameFor('t1', {
          pipelineBoxes: [
            {
              bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
              macroClass: 'animal',
              trackId: 't1',
              basis: 'subject-box',
              deltaMs: 0,
              score: 0.61,
              modelId: 'yolov9m-320',
            },
          ],
        }),
      },
    })
    await applyPlan(hub, PLAN, GO)
    expect(hub.saved[0]!.annotations[0]).toMatchObject({
      source: 'pipeline',
      assistModelId: 'yolov9m-320',
      assistScore: 0.61,
      origin: { modelId: 'yolov9m-320', score: 0.61 },
    })
  })

  it('a reviewer-drawn rectangle is an operator box with an operator origin', async () => {
    const hub = new FakeHub()
    const plan = ApplyPlanSchema.parse({
      tracks: [
        {
          ...PLAN.tracks[0]!,
          subjects: [{ bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, macroClass: 'person' }],
        },
      ],
    })
    await applyPlan(hub, plan, GO)
    expect(hub.saved[0]!.annotations[0]).toMatchObject({
      source: 'operator',
      origin: { source: 'operator' },
    })
  })

  it('saves against the revision it read, so a frame changed meanwhile is refused', async () => {
    const hub = new FakeHub({
      copies: { t1: frameFor('t1', { revision: 3 }) },
    })
    await applyPlan(hub, PLAN, GO)
    expect(hub.saved[0]!.expectedRevision).toBe(3)
  })

  it('is idempotent: a second run reuses the collection, frame and annotations', async () => {
    const hub = new FakeHub()
    await applyPlan(hub, PLAN, GO)
    const savesAfterFirst = hub.saved.length
    const r = await applyPlan(hub, PLAN, GO)
    expect(r.collection?.created).toBe(false)
    expect(hub.saved).toHaveLength(savesAfterFirst)
    expect(hub.calls.filter((c) => c === 'selectRetrainFrames')).toHaveLength(1)
    expect(hub.calls.filter((c) => c === 'createCollection')).toHaveLength(1)
    expect(r.tracks[0]!.actions).toEqual(
      expect.arrayContaining(['frame already copied', 'already in collection']),
    )
  })

  it('never replaces existing annotations without overwrite, and does with it', async () => {
    const frame = frameFor('t1')
    const seed = {
      copies: { t1: frame },
      annotations: { [frame.frameId]: [annotation(frame.frameId)] },
    }
    const kept = new FakeHub(seed)
    const r1 = await applyPlan(kept, PLAN, GO)
    expect(kept.saved).toHaveLength(0)
    expect(r1.tracks[0]!.actions.join(' ')).toContain('kept 1 existing')

    const replaced = new FakeHub(seed)
    const r2 = await applyPlan(replaced, PLAN, { ...GO, overwrite: true })
    expect(replaced.saved).toHaveLength(1)
    expect(r2.tracks[0]!.actions.join(' ')).toContain('replaced 1')
  })

  it('does not mark complete when the plan did not ask for it', async () => {
    const hub = new FakeHub()
    const plan = ApplyPlanSchema.parse({
      tracks: [{ ...PLAN.tracks[0]!, markComplete: false }],
    })
    await applyPlan(hub, plan, GO)
    expect(hub.writes).not.toContain('setRetrainFrameComplete')
  })

  it('isolates a failing track and continues with the next', async () => {
    const hub = new FakeHub({
      copies: { bad: frameFor('bad', { pipelineBoxes: [] }) },
    })
    const plan = ApplyPlanSchema.parse({
      tracks: [
        {
          ...PLAN.tracks[0]!,
          trackId: 'bad',
          subjects: [{ boxOf: 'bad', macroClass: 'animal' }],
        },
        PLAN.tracks[0],
      ],
    })
    const r = await applyPlan(hub, plan, GO)
    expect(r.tracks.map((t) => t.outcome)).toEqual(['failed', 'done'])
    expect(r.tracks[0]!.reason).toContain('no pipeline box')
  })

  it('stops the run on an auth rejection and surfaces the hub error', async () => {
    const err = new HubRpcError(
      'admin required',
      'FORBIDDEN',
      'pipelineAnalytics.setTrackFlags',
      403,
    )
    const hub = new FakeHub({
      failOn: new Set(['setTrackFlags']),
      failWith: err,
    })
    const plan = ApplyPlanSchema.parse({
      tracks: [PLAN.tracks[0], { ...PLAN.tracks[0]!, trackId: 't2' }],
    })
    const r = await applyPlan(hub, plan, GO)
    expect(r.refused).toContain('admin required')
    expect(r.tracks.map((t) => t.outcome)).toEqual(['not-attempted', 'not-attempted'])
    expect(hub.calls.filter((c) => c === 'setTrackFlags')).toHaveLength(1)
  })
})
