/**
 * A deleted proposal stays deleted.
 *
 * The bug this pins: the editor seeded pipeline boxes as drafts and de-duplicated
 * them only against SAVED rows, so a pipeline box the operator deleted — and
 * therefore never saved — came back as a draft every time the frame reopened.
 * The decision now lives in the frame's `dismissed` set.
 */
import type { RetrainAnnotation, RetrainPipelineBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addOperatorBox,
  deleteBox,
  pipelineOriginRef,
  seedEditor,
  toSaveDismissed,
  toSavePayload,
  updateBox,
} from '../lib/retrain-editor.js'

function pipeline(over: Partial<RetrainPipelineBox> = {}): RetrainPipelineBox {
  return {
    bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    macroClass: 'person',
    trackId: 't1',
    basis: 'subject-box',
    deltaMs: 0,
    score: 0.61,
    modelId: 'yolov9m-320',
    ...over,
  }
}

function saved(over: Partial<RetrainAnnotation> = {}): RetrainAnnotation {
  return {
    id: 'a1',
    trackId: 't',
    deviceId: 101,
    mediaKey: 'f',
    bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    macroClass: 'person',
    kind: 'subject',
    source: 'pipeline',
    origin: null,
    createdAt: 1,
    ...over,
  }
}

describe('a deleted pipeline box is not re-seeded', () => {
  it('deleting the draft records it as dismissed, and the saved payload carries it', () => {
    const opened = seedEditor([], [pipeline()])
    expect(opened.boxes).toHaveLength(1)
    const key = opened.boxes[0]?.key ?? ''
    const after = deleteBox(opened, key)
    expect(after.boxes).toHaveLength(0)
    expect(toSaveDismissed(after).map((d) => d.ref)).toEqual([pipelineOriginRef('t1')])
    expect(toSaveDismissed(after)[0]?.snapshot).toMatchObject({
      source: 'pipeline',
      macroClass: 'person',
      modelId: 'yolov9m-320',
      score: 0.61,
    })
  })

  it('reopening the frame with that dismissal offers nothing', () => {
    const dismissed = [
      {
        ref: pipelineOriginRef('t1'),
        snapshot: {
          source: 'pipeline' as const,
          ref: pipelineOriginRef('t1'),
          bbox: pipeline().bbox,
          macroClass: 'person' as const,
        },
      },
    ]
    const reopened = seedEditor([], [pipeline()], dismissed)
    expect(reopened.boxes).toEqual([])
    expect(reopened.dismissed).toEqual(dismissed)
  })

  it('without the dismissal the same pipeline box IS offered — the old behaviour', () => {
    expect(seedEditor([], [pipeline()]).boxes).toHaveLength(1)
  })

  it('other pipeline boxes on the frame are still offered', () => {
    const dismissed = [
      {
        ref: pipelineOriginRef('t1'),
        snapshot: {
          source: 'pipeline' as const,
          ref: pipelineOriginRef('t1'),
          bbox: pipeline().bbox,
          macroClass: 'person' as const,
        },
      },
    ]
    const reopened = seedEditor(
      [],
      [pipeline(), pipeline({ trackId: 't2', bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } })],
      dismissed,
    )
    expect(reopened.boxes).toHaveLength(1)
    expect(reopened.boxes[0]?.origin?.ref).toBe(pipelineOriginRef('t2'))
  })

  it('a box kept (even moved) by its origin ref is never re-offered, and not dismissed', () => {
    const origin = {
      source: 'pipeline' as const,
      ref: pipelineOriginRef('t1'),
      bbox: pipeline().bbox,
      macroClass: 'person' as const,
    }
    const moved = saved({ bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, origin })
    const reopened = seedEditor([moved], [pipeline()], [{ ref: origin.ref, snapshot: origin }])
    expect(reopened.boxes).toHaveLength(1)
    expect(reopened.boxes[0]?.draft).toBe(false)
    expect(reopened.dismissed).toEqual([])
  })
})

describe('deleting records only what a machine proposed', () => {
  it('a saved, accepted pipeline box is dismissed when deleted', () => {
    const origin = {
      source: 'pipeline' as const,
      ref: pipelineOriginRef('t1'),
      bbox: pipeline().bbox,
      macroClass: 'person' as const,
    }
    const opened = seedEditor([saved({ origin })], [])
    const after = deleteBox(opened, opened.boxes[0]?.key ?? '')
    expect(after.dismissed.map((d) => d.ref)).toEqual([origin.ref])
  })

  it('a box the operator drew leaves no trace when deleted', () => {
    const drawn = addOperatorBox(seedEditor([], []), { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 'person')
    const after = deleteBox(drawn, drawn.boxes[0]?.key ?? '')
    expect(after.dismissed).toEqual([])
  })

  it('an operator-drawn box saves with an operator origin', () => {
    const drawn = addOperatorBox(seedEditor([], []), { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 'person')
    expect(toSavePayload(drawn)[0]?.origin).toMatchObject({ source: 'operator' })
  })

  it('a corrected pipeline draft saves with its ORIGINAL snapshot, not the edit', () => {
    const opened = seedEditor([], [pipeline()])
    const key = opened.boxes[0]?.key ?? ''
    const edited = updateBox(opened, key, {
      bbox: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
      macroClass: 'vehicle',
    })
    const payload = toSavePayload(edited)[0]
    expect(payload?.macroClass).toBe('vehicle')
    expect(payload?.origin).toMatchObject({
      macroClass: 'person',
      bbox: pipeline().bbox,
      ref: pipelineOriginRef('t1'),
    })
  })

  it('a dismissal for a proposal that was then kept is dropped from the save', () => {
    const opened = seedEditor([], [pipeline()])
    const deleted = deleteBox(opened, opened.boxes[0]?.key ?? '')
    expect(toSaveDismissed(deleted)).toHaveLength(1)
    const kept = { ...deleted, boxes: opened.boxes.map((b) => ({ ...b, draft: false })) }
    expect(toSaveDismissed(kept)).toHaveLength(0)
  })
})
