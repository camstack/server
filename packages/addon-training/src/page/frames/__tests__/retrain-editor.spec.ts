/**
 * The annotation state of one frame: what the operator decided, and what a
 * machine proposed and nobody confirmed yet.
 *
 * The rule that matters: a machine box is a DRAFT. It is drawn, it can be
 * accepted, corrected, relabelled, turned into a model error or deleted — and
 * until one of those happens it never reaches the save payload.
 */
import type { RetrainAnnotation, RetrainPipelineBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  acceptAllDrafts,
  acceptBox,
  addDrafts,
  boxIou,
  deleteBox,
  flagBoxes,
  flagsFromReviews,
  markModelError,
  pendingDraftCount,
  pipelineDrafts,
  seedEditor,
  toSavePayload,
  updateBox,
} from '../lib/retrain-editor.js'

function saved(over: Partial<RetrainAnnotation> = {}): RetrainAnnotation {
  return {
    id: 'a1',
    trackId: 't',
    deviceId: 101,
    mediaKey: 'f',
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
    macroClass: 'person',
    kind: 'subject',
    source: 'operator',
    createdAt: 1,
    ...over,
  }
}

function pipeline(over: Partial<RetrainPipelineBox> = {}): RetrainPipelineBox {
  return {
    bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    macroClass: 'person',
    trackId: 'other',
    basis: 'position',
    deltaMs: 40,
    score: 0.61,
    modelId: 'yolov9m-320',
    ...over,
  }
}

describe('seedEditor', () => {
  it('saved annotations arrive accepted; pipeline boxes arrive as drafts', () => {
    const state = seedEditor([saved()], [pipeline()])
    expect(state.boxes.map((b) => [b.source, b.draft])).toEqual([
      ['operator', false],
      ['pipeline', true],
    ])
    expect(state.boxes[1]).toMatchObject({ assistModelId: 'yolov9m-320', assistScore: 0.61 })
    expect(pendingDraftCount(state)).toBe(1)
  })

  it('does not re-offer a pipeline box the operator already saved', () => {
    const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    const state = seedEditor([saved({ bbox: box, source: 'pipeline' })], [pipeline({ bbox: box })])
    expect(state.boxes).toHaveLength(1)
    expect(state.boxes[0]?.draft).toBe(false)
  })

  it('does not re-offer one the operator turned into a model error either', () => {
    const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    const state = seedEditor(
      [saved({ bbox: box, kind: 'model_error', source: 'pipeline' })],
      [pipeline({ bbox: { ...box, x: 0.51 } })],
    )
    expect(state.boxes).toHaveLength(1)
  })
})

describe('drafts never reach the save payload until confirmed', () => {
  it('saves accepted boxes only', () => {
    const state = seedEditor([saved()], [pipeline()])
    expect(toSavePayload(state)).toHaveLength(1)
    const accepted = acceptBox(state, state.boxes[1]!.key)
    expect(toSavePayload(accepted)).toHaveLength(2)
    expect(toSavePayload(accepted)[1]).toMatchObject({
      source: 'pipeline',
      assistModelId: 'yolov9m-320',
      assistScore: 0.61,
    })
  })

  it('correcting a draft (class, label, geometry) IS confirming it', () => {
    const state = seedEditor([], [pipeline()])
    const key = state.boxes[0]!.key
    const relabelled = updateBox(state, key, { macroClass: 'vehicle', label: 'van' })
    expect(relabelled.boxes[0]).toMatchObject({ draft: false, macroClass: 'vehicle', label: 'van' })
  })

  it('a phantom becomes a model error, with its provenance kept', () => {
    const state = seedEditor([], [pipeline()])
    const marked = markModelError(state, state.boxes[0]!.key)
    expect(toSavePayload(marked)).toEqual([
      expect.objectContaining({ kind: 'model_error', source: 'pipeline', assistScore: 0.61 }),
    ])
  })

  it('accept-all confirms every draft, delete drops one', () => {
    const state = seedEditor([], [pipeline(), pipeline({ bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } })])
    const all = acceptAllDrafts(state)
    expect(pendingDraftCount(all)).toBe(0)
    const fewer = deleteBox(all, all.boxes[0]!.key)
    expect(fewer.boxes).toHaveLength(1)
  })

  it('an empty label is not sent as a label', () => {
    const state = seedEditor([saved({ label: 'postman' })], [])
    const cleared = updateBox(state, state.boxes[0]!.key, { label: '' })
    expect(toSavePayload(cleared)[0]).not.toHaveProperty('label')
  })
})

describe('addDrafts', () => {
  it('adds proposals as drafts and skips one that duplicates a box on screen', () => {
    const state = seedEditor([saved()], [])
    const { state: next, skipped } = addDrafts(state, [
      { ...pipelineDrafts([pipeline()])[0]!, source: 'assist' },
      { ...pipelineDrafts([pipeline({ bbox: saved().bbox })])[0]!, source: 'assist' },
    ])
    expect(skipped).toBe(1)
    expect(next.boxes.map((b) => [b.source, b.draft])).toEqual([
      ['operator', false],
      ['assist', true],
    ])
  })
})

describe('boxIou', () => {
  it('is 1 for the same box and 0 for disjoint ones', () => {
    const a = { x: 0, y: 0, w: 0.5, h: 0.5 }
    expect(boxIou(a, a)).toBe(1)
    expect(boxIou(a, { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })).toBe(0)
  })
})

describe('AI reviews become flags on the boxes they name', () => {
  it('flags only the boxes that exist, and a flag never confirms a draft', () => {
    const state = seedEditor([], [pipeline()])
    const key = state.boxes[0]!.key
    const flagged = flagBoxes(
      state,
      flagsFromReviews(
        [
          { ref: key, verdict: 'not-an-object', reason: 'this is a plant' },
          { ref: 'gone', verdict: 'confirmed', reason: 'n/a' },
        ],
        'qwen3-vl',
      ),
    )
    expect(flagged.boxes[0]?.flag).toEqual({
      verdict: 'not-an-object',
      reason: 'this is a plant',
      by: 'qwen3-vl',
    })
    expect(flagged.boxes[0]?.draft).toBe(true)
    expect(toSavePayload(flagged)).toEqual([])
  })
})
