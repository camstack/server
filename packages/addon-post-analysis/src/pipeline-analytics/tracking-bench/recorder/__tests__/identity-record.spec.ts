/**
 * Where a tape's face identity comes from (review H2b). On the runner a face
 * detail carries the arcface MARKER (`embedding:512d`) and nothing else; the
 * identity is decided later, per TRACK, by the post-analysis `FaceRecognizer`.
 * So the tape learns it from the recognizer's verdict: one `identity` record
 * per settlement (or retraction), `{ t, trk, fid }`, joined to `live[].trk`.
 *
 * Real-shaped data: the frame's face carries only the marker; the name exists
 * only in the recognizer's gallery. The hook is observational — a throwing
 * observer changes no recognition outcome.
 *
 * Disarms:
 *  - drop the `onIdentityVerdict` call from the settlement loop in
 *    `face-recognizer.ts` — the settle test must fail;
 *  - remove the try/catch around the observer — the neutrality test must fail.
 *
 * The veto-lifted-re-bind retraction test this file once pinned went with the
 * quarantine/stash mechanism it exercised (D683 Task 21): tracker v2 never
 * resurrects an id, so nothing marks a held face unverified and nothing
 * retracts its label on a later rejection.
 */
import type { FrameResult, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type FaceIdentityVerdict,
  FaceRecognizer,
  type FaceRecognizerDeps,
} from '../../../face-recognizer.js'
import { FACE_DEFAULTS, type FaceSettings } from '../../../face-settings.js'
import type { TrackedDetectionOut } from '../../../pipeline/frame-processor.js'
import { decodeTapeText, encodeTapeLine } from '../../tape-codec.js'
import { parseTapeRecord } from '../../tape-schema.js'
import { sampleEnd, sampleHeader } from '../../__tests__/tape-fixtures.js'
import { buildFrameRecord, buildIdentityRecord } from '../frame-record.js'
import { EMBEDDING_MARKER, faces } from './frame-record-fixtures.js'

const MODEL = 'arcface-r100'
const ALICE_ID = 'id-alice'
const ALICE_NAME = 'Alice'
const FACE_ALICE: readonly number[] = [1, 0, 0, 0]
const TRACK = 'trk-7Qx'

const SETTINGS: FaceSettings = {
  ...FACE_DEFAULTS,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
  confirmFrames: 2,
}

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly rec: FaceRecognizer
  readonly verdicts: FaceIdentityVerdict[]
  readonly applyLabelCandidate: ReturnType<
    typeof vi.fn<FaceRecognizerDeps['trackStore']['applyLabelCandidate']>
  >
}

async function harness(observer?: (v: FaceIdentityVerdict) => void): Promise<Harness> {
  const verdicts: FaceIdentityVerdict[] = []
  const applyLabelCandidate = vi.fn<FaceRecognizerDeps['trackStore']['applyLabelCandidate']>(
    async () => null,
  )
  const d: FaceRecognizerDeps = {
    identityStore: {
      loadGallery: async () => [{ identityId: ALICE_ID, embedding: FACE_ALICE, modelId: MODEL }],
      listIdentities: async () => [{ id: ALICE_ID, name: ALICE_NAME }],
    },
    faceStore: { insert: async () => {} },
    mediaStore: { put: async () => 77 },
    trackStore: { applyLabelCandidate },
    eventStore: { projectTrackLabel: async () => 0 },
    captureCrop: async () => null,
    onIdentityVerdict:
      observer ??
      ((v) => {
        verdicts.push(v)
      }),
    logger: silentLogger(),
  }
  const rec = new FaceRecognizer(d)
  await rec.refreshGallery()
  return { rec, verdicts, applyLabelCandidate }
}

/** The tracker's output for the person the face detail belongs to. */
function tracked(): TrackedDetectionOut {
  return {
    trackId: TRACK,
    className: 'person',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 100, h: 300 },
    faceBbox: { x: 30, y: 10, w: 40, h: 40 },
    zones: [],
    state: 'moving',
    matchedThisFrame: true,
    settling: false,
    confirmed: true,
    embedding: FACE_ALICE,
    embeddingModelId: MODEL,
    sourceDetectionId: 'd1',
  }
}

async function feed(rec: FaceRecognizer, ts: number, t: TrackedDetectionOut): Promise<void> {
  await rec.processFrame({
    deviceId: 101,
    timestamp: ts,
    frameWidth: 1280,
    frameHeight: 720,
    tracked: [t],
    settings: SETTINGS,
    cropPadding: 0,
  })
}

/** The frame the runner shipped: the person and its face, marker only. */
const FRAME: FrameResult = {
  kind: 'frame',
  frameId: 'frame-1',
  deviceId: 101,
  timestamp: 1000,
  width: 1280,
  height: 720,
  detections: [
    {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.9,
      labels: [],
      bbox: { x: 0, y: 0, width: 100, height: 300 },
    },
    {
      id: 'd1-face',
      kind: 'detail',
      macroClass: 'face',
      score: 0.8,
      labels: [EMBEDDING_MARKER],
      bbox: { x: 30, y: 10, width: 40, height: 40 },
      parentId: 'd1',
      embedding: [...FACE_ALICE],
      embeddingModelId: MODEL,
    },
  ],
}

describe('identity records', () => {
  it('the frame knows no identity; the recognizer settles it and the tape records a pseudonym', async () => {
    const frameRecord = buildFrameRecord({
      t: 0,
      plane: 'pipeline',
      frame: FRAME,
      injectedIds: new Set(),
      observation: {
        gate: { strong: [], weak: [], confirmed: [], woken: [] },
        live: [{ trackId: TRACK, detectionId: 'd1', matched: true, state: 'moving' }],
      },
      faces,
    })
    expect(frameRecord.dets.every((d) => d.fid === undefined)).toBe(true)

    const h = await harness()
    await feed(h.rec, 1000, tracked())
    expect(h.verdicts).toEqual([])
    await feed(h.rec, 1100, tracked())
    expect(h.verdicts).toEqual([
      { deviceId: 101, trackId: TRACK, timestamp: 1100, identityId: ALICE_ID },
    ])

    const verdict = h.verdicts[0]
    if (verdict === undefined) throw new Error('no verdict')
    const identity = buildIdentityRecord({
      t: verdict.timestamp - FRAME.timestamp,
      trackId: verdict.trackId,
      identityId: verdict.identityId,
      faces,
    })
    expect(identity).toEqual({
      kind: 'identity',
      t: 100,
      trk: TRACK,
      fid: faces.pseudonym(ALICE_ID),
    })
    // Joinable to what the live tracker bound on the frame.
    expect(frameRecord.live[0]?.trk).toBe(identity.trk)
    const json = JSON.stringify(identity)
    expect(json).not.toContain(ALICE_NAME)
    expect(json).not.toContain(ALICE_ID)
  })

  it('a throwing observer changes no recognition outcome', async () => {
    const quiet = await harness(() => {})
    const loud = await harness(() => {
      throw new Error('recorder down')
    })
    for (const h of [quiet, loud]) {
      await feed(h.rec, 1000, tracked())
      await feed(h.rec, 1100, tracked())
    }
    const strip = (calls: typeof quiet.applyLabelCandidate.mock.calls) =>
      calls.map(([trackId, c]) => ({ trackId, text: c.text, identityId: c.identityId }))
    expect(strip(loud.applyLabelCandidate.mock.calls)).toEqual(
      strip(quiet.applyLabelCandidate.mock.calls),
    )
    expect(quiet.applyLabelCandidate).toHaveBeenCalledTimes(1)
    expect(loud.rec.bestLabelMatchConfidence(TRACK)).toBe(quiet.rec.bestLabelMatchConfidence(TRACK))
  })

  it('is strict and round-trips through the codec', () => {
    const identity = buildIdentityRecord({ t: 5, trackId: TRACK, identityId: ALICE_ID, faces })
    const tape = decodeTapeText(
      [sampleHeader(), identity, sampleEnd()].map((r) => encodeTapeLine(r)).join(''),
    )
    expect(tape.body).toEqual([identity])
    expect(() => parseTapeRecord({ ...identity, name: ALICE_NAME }, 1)).toThrow()
    expect(() => parseTapeRecord({ ...identity, fid: ALICE_NAME }, 1)).toThrow()
  })

  it('a null identity encodes as a null fid, never a pseudonym', () => {
    // Pure-function coverage, independent of WHY a verdict settled on `null`
    // (a retraction was one such reason before D683 Task 21; it is not the
    // only conceivable one, and `buildIdentityRecord` does not care which).
    expect(buildIdentityRecord({ t: 8000, trackId: TRACK, identityId: null, faces })).toEqual({
      kind: 'identity',
      t: 8000,
      trk: TRACK,
      fid: null,
    })
  })
})
