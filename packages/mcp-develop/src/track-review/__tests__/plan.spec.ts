import { describe, expect, it } from 'vitest'
import { buildPlan, SubjectSpecSchema, VerdictSchema } from '../plan.js'

const wrong = VerdictSchema.parse({
  trackId: 't1',
  deviceId: 5,
  verdict: 'wrong-class',
  correctClass: { macroClass: 'animal', label: 'dog' },
  complete: true,
})

describe('buildPlan', () => {
  it('plans the full write sequence for a wrong-class verdict', () => {
    const plan = buildPlan([wrong])
    expect(plan.tracks).toHaveLength(1)
    const t = plan.tracks[0]!
    expect(t.steps).toEqual([
      'setTrackFlags',
      'selectRetrainFrames',
      'saveRetrainAnnotations',
      'setRetrainFrameComplete',
      'addRetrainFramesToCollection',
    ])
    expect(t.subjects).toEqual([{ boxOf: 't1', macroClass: 'animal', label: 'dog' }])
    expect(plan.totals).toEqual({ toWrite: 1, skipped: 0, complete: 1 })
  })

  it('does not mark complete unless the reviewer says every subject is boxed', () => {
    const plan = buildPlan([{ ...wrong, complete: undefined }])
    expect(plan.tracks[0]!.markComplete).toBe(false)
    expect(plan.tracks[0]!.steps).not.toContain('setRetrainFrameComplete')
    expect(plan.warnings.join(' ')).toContain('not marked complete')
  })

  it('turns a false positive into a model_error box of the pipeline box', () => {
    const plan = buildPlan([
      VerdictSchema.parse({
        trackId: 'fp',
        deviceId: 1,
        verdict: 'false-positive',
      }),
    ])
    expect(plan.tracks[0]!.subjects).toEqual([{ boxOf: 'fp', kind: 'model_error' }])
  })

  it('writes nothing for correct, pipeline-bug and unsure — and says why', () => {
    const plan = buildPlan(
      (['correct', 'pipeline-bug', 'unsure'] as const).map((verdict, i) =>
        VerdictSchema.parse({ trackId: `x${i}`, deviceId: 1, verdict }),
      ),
    )
    expect(plan.tracks).toHaveLength(0)
    expect(plan.skipped.map((s) => s.verdict)).toEqual(['correct', 'pipeline-bug', 'unsure'])
    expect(plan.skipped.every((s) => s.reason.length > 0)).toBe(true)
  })

  it('skips a wrong-class verdict that names no class and no subjects', () => {
    const plan = buildPlan([
      VerdictSchema.parse({
        trackId: 'n',
        deviceId: 1,
        verdict: 'wrong-class',
      }),
    ])
    expect(plan.tracks).toHaveLength(0)
    expect(plan.skipped[0]!.reason).toContain('nothing to annotate')
  })

  it('keeps explicit subjects, including other subjects in the frame', () => {
    const plan = buildPlan([
      VerdictSchema.parse({
        trackId: 't',
        deviceId: 1,
        verdict: 'wrong-class',
        subjects: [
          { boxOf: 't', macroClass: 'animal', label: 'dog' },
          { bbox: { x: 0, y: 0, w: 0.3, h: 0.5 }, macroClass: 'person' },
        ],
      }),
    ])
    expect(plan.tracks[0]!.subjects).toHaveLength(2)
  })

  it('warns when one track has several verdicts and the last wins', () => {
    const plan = buildPlan([wrong, { ...wrong, correctClass: { macroClass: 'person' } }])
    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0]!.subjects[0]!.macroClass).toBe('person')
    expect(plan.warnings.join(' ')).toContain('last one wins')
  })
})

describe('SubjectSpecSchema', () => {
  it('needs exactly one of bbox / boxOf', () => {
    expect(SubjectSpecSchema.safeParse({ macroClass: 'person' }).success).toBe(false)
    expect(
      SubjectSpecSchema.safeParse({
        boxOf: 'a',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        macroClass: 'person',
      }).success,
    ).toBe(false)
  })

  it('needs a macroClass with an explicit bbox', () => {
    expect(SubjectSpecSchema.safeParse({ bbox: { x: 0, y: 0, w: 1, h: 1 } }).success).toBe(false)
  })
})

describe('buildPlan note and collection', () => {
  it('keeps each verdict note in the plan, planned or skipped', () => {
    const plan = buildPlan([
      { ...wrong, note: 'a dog behind the fence' },
      VerdictSchema.parse({
        trackId: 't2',
        deviceId: 5,
        verdict: 'unsure',
        note: 'too dark',
      }),
    ])
    expect(plan.tracks[0]!.note).toBe('a dog behind the fence')
    expect(plan.skipped[0]!.note).toBe('too dark')
  })

  it('carries the collection name so the plan is self-contained', () => {
    expect(buildPlan([wrong], ' review-a ').collectionName).toBe('review-a')
    expect(buildPlan([wrong]).collectionName).toBeUndefined()
  })
})
