/**
 * FaceRecognizer → semantic best-shot signal.
 *
 * ## What the signal means (D406, 2026-09-08 — supersedes the 2026-08-21 rule)
 *
 * Originally it fired ONLY on a gallery AUTO-MATCH: the semantic tier meant
 * "this frame proved WHO the subject is". That made the tier unreachable for
 * every stranger, which is most of the fleet's traffic — and the operator's
 * complaint is not about identity:
 *
 *   101 `acad3a3e` (person, 7.1 s): "il keyframe è preso a metà busto quando
 *   abbiamo un frame con la faccia completamente visibile" [the keyframe is taken at half bust when we have a frame with the face completely visible]
 *
 * That track carries `hasFace`/`hasEmbeddedFace` and a stored `faceCrop`, and
 * NO `recognizedIdentityId` — nobody in the gallery. The face frame therefore
 * never carried the semantic bit and lost, on size, to a later torso-only view.
 *
 * So the signal now fires for every candidate that cleared the RECOGNITION
 * size floor and produced an embedding — a face resolved well enough to
 * identify is a face resolved well enough to be the shot — and it carries the
 * identity only when there is one. No new threshold: `recognitionMinFacePx` is
 * the existing operator knob (D222).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    identityStore: {
      loadGallery: vi.fn(async (): Promise<readonly GallerySample[]> => []),
      listIdentities: vi.fn(async () => [] as readonly { id: string; name: string }[]),
    },
    faceStore: { insert: vi.fn(async () => {}) },
    mediaStore: { put: vi.fn(async () => 'k') },
    trackStore: { applyLabelCandidate: vi.fn(async () => null) },
    eventStore: { projectTrackLabel: vi.fn(async () => 0) },
    captureCrop: vi.fn(async () => Buffer.from('jpg')),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    ...overrides,
  }
}

const SETTINGS = {
  ...FACE_DEFAULTS,
  similarityThreshold: 0.45,
  margin: 0.12,
  confirmFrames: 3,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
}

const PERSON_BBOX = { x: 100, y: 50, w: 60, h: 120 }

function candidate(embedding: number[], faceShortSidePx?: number) {
  return makeTrackedDetectionOut({
    trackId: 't1',
    confidence: 0.8,
    bbox: PERSON_BBOX,
    faceBbox: { x: 110, y: 60, w: 20, h: 20 },
    embedding,
    embeddingModelId: 'auraface-r100',
    ...(faceShortSidePx !== undefined ? { nativeFaceShortSidePx: faceShortSidePx } : {}),
  })
}

async function processOnce(
  rec: FaceRecognizer,
  embedding: number[],
  settings: typeof SETTINGS = SETTINGS,
  faceShortSidePx?: number,
) {
  await rec.processFrame({
    deviceId: 104,
    timestamp: 1_000,
    frameWidth: 640,
    frameHeight: 360,
    tracked: [candidate(embedding, faceShortSidePx)],
    settings,
    cropPadding: 0,
  })
}

describe('FaceRecognizer — onSemanticFace', () => {
  it('fires on a per-frame AUTO-MATCH (even before confirmFrames confirms the identity)', async () => {
    const onSemanticFace = vi.fn()
    const d = deps({ onSemanticFace })
    d.identityStore.loadGallery.mockResolvedValue([
      { identityId: 'id-g', embedding: [1, 0, 0, 0], modelId: 'auraface-r100' },
    ])
    d.identityStore.listIdentities.mockResolvedValue([{ id: 'id-g', name: 'Alice' }])
    const rec = new FaceRecognizer(d as never)
    await rec.refreshGallery()
    // cosine([1,0,0,0], [0.9, 0.436, 0, 0]) ≈ 0.9 ≥ 0.45; single frame — the
    // confirmFrames(3) aggregate has NOT confirmed, the semantic signal fires anyway.
    await processOnce(rec, [0.9, Math.sqrt(1 - 0.81), 0, 0])
    expect(onSemanticFace).toHaveBeenCalledTimes(1)
    const info = onSemanticFace.mock.calls[0]![0] as Record<string, unknown>
    expect(info).toMatchObject({
      deviceId: 104,
      trackId: 't1',
      timestamp: 1_000,
      frameWidth: 640,
      frameHeight: 360,
      bbox: PERSON_BBOX,
      confidence: 0.8,
      identityId: 'id-g',
    })
    expect(info['matchScore']).toBeCloseTo(0.9, 5)
  })

  it('STILL fires on a suggestion-band score — the face is visible, it is just nobody we know', async () => {
    const onSemanticFace = vi.fn()
    const d = deps({ onSemanticFace })
    d.identityStore.loadGallery.mockResolvedValue([
      { identityId: 'id-g', embedding: [1, 0, 0, 0], modelId: 'auraface-r100' },
    ])
    d.identityStore.listIdentities.mockResolvedValue([{ id: 'id-g', name: 'Alice' }])
    const rec = new FaceRecognizer(d as never)
    await rec.refreshGallery()
    // cosine ≈ 0.30 < 0.45: no auto-match.
    await processOnce(rec, [0.3, Math.sqrt(1 - 0.09), 0, 0])
    expect(onSemanticFace).toHaveBeenCalledTimes(1)
    const info = onSemanticFace.mock.calls[0]![0] as Record<string, unknown>
    expect(info).toMatchObject({ trackId: 't1', bbox: PERSON_BBOX, confidence: 0.8 })
    // No identity was proved, and the payload does not pretend one was.
    expect(info['identityId']).toBeUndefined()
    expect(info['matchScore']).toBeUndefined()
  })

  it('fires with an EMPTY gallery (collect-only) — the acad3a3e case', async () => {
    const onSemanticFace = vi.fn()
    const d = deps({ onSemanticFace })
    const rec = new FaceRecognizer(d as never)
    await rec.refreshGallery()
    await processOnce(rec, [1, 0, 0, 0])
    expect(onSemanticFace).toHaveBeenCalledTimes(1)
    expect(
      (onSemanticFace.mock.calls[0]![0] as Record<string, unknown>)['identityId'],
    ).toBeUndefined()
  })

  it('does NOT fire for a face below the RECOGNITION size floor', async () => {
    // The floor stays the bar: a 12 px face is not "la faccia completamente
    // visibile", and promoting it would hand the best shot to a distant blur.
    const onSemanticFace = vi.fn()
    const d = deps({ onSemanticFace })
    const rec = new FaceRecognizer(d as never)
    await rec.refreshGallery()
    await processOnce(rec, [1, 0, 0, 0], { ...SETTINGS, recognitionMinFacePx: 40 }, 12)
    expect(onSemanticFace).not.toHaveBeenCalled()
  })
})
