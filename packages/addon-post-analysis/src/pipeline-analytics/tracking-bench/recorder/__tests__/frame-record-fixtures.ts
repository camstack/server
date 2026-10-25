/**
 * Shared fixtures for the frame-record specs. `FULL` and `FRAME` set EVERY field
 * of their type (review M2). The compile-time gate is the fate tables in
 * `frame-record.ts` (tsc does not check `__tests__`); the whitelist spec then
 * asserts these fixtures populate every key the tables name, so a field added
 * to the type reaches this fixture before the guard can pass again.
 */
import { APPEARANCE_BIN_COUNT, type FrameResult, type ObjectDetection } from '@camstack/types'
import type { FrameObservation } from '../../../pipeline/frame-observation.js'
import { hubFacePseudonymizer } from '../frame-record.js'

export const faces = hubFacePseudonymizer(Buffer.alloc(32, 7))

/** The runner's arcface marker — what a face detail's `labels[0]` really is. */
export const EMBEDDING_MARKER = { label: 'embedding:512d', score: 1 }

/** Every optional field populated. A person that carries a plate read and an
 *  inherited name, to prove neither reaches the record. */
export const FULL = {
  id: 'p-1',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.91,
  labels: [{ label: 'Alice', score: 0.8 }],
  track: { trackId: 'trk-SECRETTRACK' },
  bbox: { x: 10.25, y: 20.5, width: 30, height: 90 },
  refinedBbox: { x: 11, y: 21, width: 29, height: 88 },
  mask: 'AAAA',
  maskWidth: 4,
  maskHeight: 4,
  parentId: 'p-0',
  rootSupplied: { stepId: 'face-detection', modelId: 'frigate-plus' },
  embedding: [0.1, 0.2],
  embeddingModelId: 'clip',
  embeddingMagnitude: 4.2,
  faceAlignedCrop: '/9j/ALIGNED',
  nativeFaceShortSidePx: 48,
  landmarks: [{ x: 1, y: 2 }],
  nativeRecovery: { score: 0.6, cropSidePx: 640, viewPx: 1280 },
  birthEvidence: {
    jpegBase64: '/9j/SECRET',
    rect: { x: 0, y: 0, width: 5, height: 5 },
    tier: 'analysis',
  },
  debug: {
    originalClass: 'person',
    originalClassTier: 1,
    stepLatencyMs: { root: 12 },
    extractMode: 'full-frame',
  },
  appearance: {
    version: 1,
    bins: Array.from({ length: APPEARANCE_BIN_COUNT }, () => 1),
    gray: false,
  },
} satisfies Required<ObjectDetection>

/** A face detail exactly as the runner ships it: the arcface marker, a vector
 *  and the aligned crop — no identity (recognition runs later, per track). */
export const FACE_AS_SHIPPED: ObjectDetection = {
  id: 'f-1',
  kind: 'detail',
  macroClass: 'face',
  score: 0.77,
  labels: [EMBEDDING_MARKER],
  bbox: { x: 20, y: 25, width: 10, height: 12 },
  parentId: 'p-1',
  embedding: [0.3],
  faceAlignedCrop: '/9j/ALIGNED',
  nativeFaceShortSidePx: 48,
  landmarks: [{ x: 1, y: 2 }],
}

/** A face detail with a DECLARED instance-tier label behind the marker — the
 *  shape a runner-side recognition step would ship. None exists today; this
 *  is the only way `fid`/`fs` are reachable from a frame, so the key-set guard
 *  needs it. */
export const FACE_RECOGNISED: ObjectDetection = {
  id: 'f-2',
  kind: 'detail',
  macroClass: 'face',
  score: 0.74,
  labels: [EMBEDDING_MARKER, { label: 'Alice', score: 0.66, tier: 2 }],
  bbox: { x: 22, y: 26, width: 10, height: 12 },
  parentId: 'p-1',
}

export const PLATE: ObjectDetection = {
  id: 'pl-1',
  kind: 'detail',
  macroClass: 'plate',
  score: 0.7,
  labels: [{ label: 'AB123CD', score: 0.9, tier: 2 }],
  bbox: { x: 40, y: 60, width: 20, height: 8 },
  parentId: 'p-1',
}

export const FRAME = {
  kind: 'frame',
  frameId: 'frame-1',
  deviceId: 101,
  timestamp: 1_700_000_000_000,
  width: 1280,
  height: 720,
  detections: [FULL, FACE_AS_SHIPPED, FACE_RECOGNISED, PLATE],
  discarded: [
    { bbox: [1, 2, 3, 4], macroClass: 'animal', score: 0.31, reason: 'below-threshold' },
    { bbox: [5, 6, 7, 8], macroClass: 'animal', score: 0.2, reason: 'below-threshold' },
  ],
  shed: true,
  shedReason: 'overload',
  rootModelId: 'yolo-v9',
  rootStepId: 'object-detection',
  rootDeviceKey: 'openvino:npu',
  packageLooked: true,
  debug: { totalInferenceMs: 33, engine: 'python/coreml' },
} satisfies Required<FrameResult>

export const OBSERVATION: FrameObservation = {
  gate: { strong: [{ detectionId: 'x', entryId: 'e' }], weak: ['y'], confirmed: ['e'], woken: [] },
  live: [
    {
      trackId: 'trk-1',
      detectionId: 'p-1',
      matched: true,
      state: 'moving',
      heldByLowScore: true,
    },
  ],
}
