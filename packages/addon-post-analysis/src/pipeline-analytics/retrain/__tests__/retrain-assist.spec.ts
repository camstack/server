/**
 * The proposal path — availability gating, the package threshold, and the tier
 * guard.
 *
 * Three things are pinned:
 *
 *  1. **A package assist with no zone REFUSES.** It must never fall back to the
 *     whole frame: `rfdetr-package` at 0.35 on a full frame proposes furniture,
 *     and the fallback would look like "the model is bad at packages" for as
 *     long as nobody checked which rectangle it ran on.
 *  2. **The 0.35 filter is ours.** `runStatelessStep` has no threshold field, so
 *     a step run through it uses its catalog default — if this module does not
 *     filter, nothing does.
 *  3. **A macro class is never a label.** A detector class outside our macro set
 *     lands in the LABEL tier, and the write-side guard refuses a macro class
 *     typed into the label field in any casing.
 */

import type { DetailResult, MediaFileKind, MediaFileRef } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  mapAssistDetails,
  PACKAGE_ASSIST_MIN_SCORE,
  PACKAGE_MODEL_ID,
  PACKAGE_STEP_ID,
  planAssist,
  proposalToDraft,
} from '../retrain-assist.js'
import { autoPickRetrainFrame, selectableRetrainFrames } from '../retrain-frame-selection.js'
import { checkTierSeparation, isRetrainMacroClass } from '../retrain-taxonomy.js'

function detail(over: Partial<DetailResult>): DetailResult {
  return { stepId: 'object-detection', className: 'person', score: 0.9, ...over }
}

describe('planAssist', () => {
  it('runs the package model on the ZONE, at 0.35', () => {
    const zone = { x: 0.4, y: 0.6, w: 0.2, h: 0.2 }
    expect(planAssist({ kind: 'package', zone })).toEqual({
      stepId: PACKAGE_STEP_ID,
      modelId: PACKAGE_MODEL_ID,
      bbox: zone,
      minScore: PACKAGE_ASSIST_MIN_SCORE,
      className: 'package',
    })
  })

  it('REFUSES a package assist with no zone rather than falling back to the frame', () => {
    expect(planAssist({ kind: 'package', zone: null })).toBeNull()
  })

  it('runs everything else on the whole frame', () => {
    const plan = planAssist({ kind: 'objects', modelId: 'yolo26n', minScore: 0.5 })!
    expect(plan.bbox).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(plan.modelId).toBe('yolo26n')
  })
})

describe('mapAssistDetails', () => {
  const frame = { frameWidth: 1000, frameHeight: 500 }

  it('normalises the runner pixel box against the frame it was sent', () => {
    const { proposals } = mapAssistDetails({
      details: [detail({ bbox: { x: 100, y: 50, w: 200, h: 100 } })],
      modelId: 'yolo26n',
      minScore: 0.3,
      ...frame,
    })
    expect(proposals[0]!.bbox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(proposals[0]!.modelId).toBe('yolo26n')
  })

  it('drops proposals below the threshold and COUNTS them', () => {
    const { proposals, belowThreshold } = mapAssistDetails({
      details: [
        detail({ score: 0.34, bbox: { x: 0, y: 0, w: 10, h: 10 } }),
        detail({ score: 0.36, bbox: { x: 0, y: 0, w: 10, h: 10 } }),
      ],
      modelId: PACKAGE_MODEL_ID,
      minScore: PACKAGE_ASSIST_MIN_SCORE,
      ...frame,
    })
    expect(proposals).toHaveLength(1)
    expect(belowThreshold).toBe(1)
  })

  it('keeps an unknown detector class as the LABEL, never as the macro class', () => {
    const { proposals } = mapAssistDetails({
      details: [detail({ className: 'dog', bbox: { x: 0, y: 0, w: 10, h: 10 } })],
      modelId: 'yolo26n',
      minScore: 0,
      ...frame,
    })
    expect(isRetrainMacroClass(proposals[0]!.macroClass)).toBe(true)
    expect(proposals[0]!.label).toBe('dog')
  })

  it('counts a detail with no box instead of inventing one', () => {
    const { proposals, withoutBox } = mapAssistDetails({
      details: [detail({ bbox: undefined })],
      modelId: 'x',
      minScore: 0,
      ...frame,
    })
    expect(proposals).toEqual([])
    expect(withoutBox).toBe(1)
  })

  it('carries the model and score into the draft as PROVENANCE', () => {
    const { proposals } = mapAssistDetails({
      details: [detail({ score: 0.71, bbox: { x: 0, y: 0, w: 10, h: 10 } })],
      modelId: 'yolo26n',
      minScore: 0,
      ...frame,
    })
    const draft = proposalToDraft(proposals[0]!, {
      trackId: 't1',
      deviceId: 101,
      mediaKey: 'retrain:t1:abc',
    })
    expect(draft).toMatchObject({
      source: 'assist',
      assistModelId: 'yolo26n',
      assistScore: 0.71,
      kind: 'subject',
    })
  })
})

describe('tier separation — a macro class is never a label', () => {
  it('refuses a macro class in the label field, whatever the casing', () => {
    expect(checkTierSeparation({ label: 'person' })).toEqual({ field: 'label', value: 'person' })
    expect(checkTierSeparation({ label: ' Person ' })).toMatchObject({ field: 'label' })
    expect(checkTierSeparation({ subLabel: 'VEHICLE' })).toMatchObject({ field: 'subLabel' })
  })

  it('accepts a real label and a real sub-label', () => {
    expect(checkTierSeparation({ label: 'postman', subLabel: 'Marco' })).toBeNull()
  })
})

describe('frame availability gating', () => {
  const info = (mediaId: number, kind: MediaFileKind, sizeBytes: number): MediaFileRef => ({
    mediaId,
    kind,
    timestamp: 1,
    sizeBytes,
  })

  it('offers only whole, unannotated frames', () => {
    const frames = selectableRetrainFrames([
      info(1, 'keyFrame', 100),
      info(2, 'thumbnail', 999),
      info(3, 'fullFrameBoxed', 999),
      info(4, 'faceCrop', 999),
      info(5, 'crop', 999),
    ])
    expect(frames.map((f) => f.mediaId)).toEqual([1])
  })

  it('auto-picks the NATIVE key frame even when a downscale weighs more', () => {
    const pick = autoPickRetrainFrame([
      info(1, 'keyFrameSmall', 900_000),
      info(2, 'keyFrame', 120_000),
    ])
    expect(pick?.mediaId).toBe(2)
  })

  it('reports null when the track has no annotatable frame left', () => {
    expect(autoPickRetrainFrame([info(1, 'thumbnail', 10)])).toBeNull()
  })
})
