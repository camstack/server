/**
 * A retrain annotation is anchored only to a CLEAN whole frame (D654).
 *
 * `RETRAIN_FRAME_KINDS` listed `firstFrame` / `lastFrame` / `snapshot` as
 * "unannotated"; all three carry the track's box burned in. The notification
 * centre's `ANNOTATED_SCENE_KINDS` is the one declaration of which kinds are
 * boxed, so the two lists are pinned against each other here.
 */
import { describe, expect, it } from 'vitest'
import { ANNOTATED_SCENE_KINDS } from '../../../notification-center/rule-engine.js'
import { isRetrainFrameKind, RETRAIN_FRAME_KINDS } from '../retrain-frame-selection.js'

describe('retrain frame kinds', () => {
  it('holds no annotated kind', () => {
    for (const kind of ANNOTATED_SCENE_KINDS) expect(isRetrainFrameKind(kind)).toBe(false)
  })

  it('offers the clean twins of the timeline tiles', () => {
    expect(RETRAIN_FRAME_KINDS).toEqual(expect.arrayContaining(['sceneFrame', 'lastSceneFrame']))
  })
})
