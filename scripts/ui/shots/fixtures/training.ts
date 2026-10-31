/**
 * The Training addon page (`/addon/training`, Frames tab): a corpus KPI, one
 * collection and a page of frames. The first frame is the one to open — it
 * carries a box in EVERY review state (added, removed, reclassified,
 * adjusted, unchanged, model-error) plus one draft, so the annotation editor
 * can be shot with the whole diff vocabulary on screen.
 *
 * The pixels are a synthetic scene served by the harness
 * (`harness/stubs/training-frame.ts`); camera names are generic.
 */
import {
  classifyRetrainReview,
  summarizeReview,
  type RetrainAnnotation,
  type RetrainCorpusPageFrame,
  type RetrainDismissed,
  type RetrainFrameReview,
  type RetrainOrigin,
  type RetrainPipelineBox,
} from '@camstack/types'
import { defineFixtures } from './_define'
import { NOW } from './_time'

type Bbox = RetrainOrigin['bbox']

const box = (x: number, y: number, w: number, h: number): Bbox => ({ x, y, w, h })

export const OPEN_FRAME_ID = 'demo-frame-1'
const DEVICE = 101

const personBox = box(0.2, 0.36, 0.08, 0.46)
const carBox = box(0.5, 0.52, 0.26, 0.3)
const carOrigin = box(0.48, 0.5, 0.3, 0.34)
const parcelBox = box(0.36, 0.72, 0.05, 0.1)
const catBox = box(0.08, 0.68, 0.09, 0.14)
const plantBox = box(0.92, 0.42, 0.06, 0.4)
const postBox = box(0.45, 0.6, 0.04, 0.12)
const person2Box = box(0.8, 0.4, 0.06, 0.42)

const origin = (
  ref: string,
  macroClass: RetrainOrigin['macroClass'],
  bbox: Bbox,
  label?: string,
): RetrainOrigin => ({
  source: 'pipeline',
  ref,
  bbox,
  macroClass,
  score: 0.71,
  modelId: 'detector-demo',
  ...(label !== undefined ? { label } : {}),
})

const o1 = origin('pipeline:t1', 'person', personBox, 'courier')
const o2 = origin('pipeline:t2', 'vehicle', carOrigin, 'delivery van')
const o4 = origin('pipeline:t4', 'person', catBox)
const o5 = origin('pipeline:t5', 'person', plantBox)
const o3 = origin('pipeline:t3', 'vehicle', postBox)

const saved = (
  id: string,
  bbox: Bbox,
  macroClass: RetrainAnnotation['macroClass'],
  originOf: RetrainOrigin | null,
  extra: Partial<RetrainAnnotation> = {},
): RetrainAnnotation => ({
  id,
  deviceId: DEVICE,
  mediaKey: OPEN_FRAME_ID,
  bbox,
  macroClass,
  kind: 'subject',
  source: originOf?.source ?? 'operator',
  origin: originOf ?? { source: 'operator', ref: `operator:${id}`, bbox, macroClass },
  createdAt: NOW - 3_600_000,
  ...extra,
})

const OPEN_ANNOTATIONS: readonly RetrainAnnotation[] = [
  saved('a1', personBox, 'person', o1, { label: 'courier' }),
  saved('a2', carBox, 'vehicle', o2, { label: 'delivery van' }),
  saved('a3', parcelBox, 'package', null),
  saved('a4', catBox, 'animal', o4, { label: 'cat' }),
  saved('a5', plantBox, 'person', o5, { kind: 'model_error' }),
]
const OPEN_DISMISSED: readonly RetrainDismissed[] = [{ ref: 'pipeline:t3', snapshot: o3 }]
const OPEN_PIPELINE: readonly RetrainPipelineBox[] = [
  {
    bbox: personBox,
    macroClass: 'person',
    label: 'courier',
    score: 0.71,
    modelId: 'detector-demo',
    trackId: 't1',
    basis: 'subject-box',
    deltaMs: 0,
  },
  {
    bbox: person2Box,
    macroClass: 'person',
    score: 0.58,
    modelId: 'detector-demo',
    trackId: 't6',
    basis: 'position',
    deltaMs: 240,
  },
]

function reviewOf(): RetrainFrameReview {
  const review = classifyRetrainReview(
    OPEN_ANNOTATIONS.map((a) => ({
      id: a.id,
      bbox: a.bbox,
      macroClass: a.macroClass,
      ...(a.label !== undefined ? { label: a.label } : {}),
      kind: a.kind,
      origin: a.origin ?? null,
    })),
    [],
    OPEN_DISMISSED,
  )
  return { boxes: review.boxes, summary: summarizeReview(review) }
}

const CAMERA_IDS = [101, 102, 103] as const

const FRAMES: readonly RetrainCorpusPageFrame[] = Array.from({ length: 8 }, (_, i) => {
  const n = i + 1
  const base = {
    frameId: `demo-frame-${String(n)}`,
    deviceId: CAMERA_IDS[i % CAMERA_IDS.length] ?? DEVICE,
    origin: 'track' as const,
    trackId: `track-${String(n)}`,
    sourceKind: 'fullFrame' as const,
    sizeBytes: 180_000,
    width: 1280,
    height: 720,
    copiedAt: NOW - n * 3_600_000,
    capturedAt: NOW - n * 3_600_000 - 5_000,
    imageUrl: `/addon/pipeline-analytics/retrain-frame/demo-frame-${String(n)}?size=full`,
    thumbnailUrl: `/addon/pipeline-analytics/retrain-frame/demo-frame-${String(n)}?size=thumb`,
  }
  if (n === 1) {
    return {
      ...base,
      deviceId: DEVICE,
      complete: false,
      workState: 'annotated' as const,
      revision: 3,
      pipelineBoxes: OPEN_PIPELINE,
      dismissed: OPEN_DISMISSED,
      // The operator answered "wrong: it is a neighbour" on the notification of
      // the second pipeline box: it opens as a pending reclassification.
      verdict: {
        verdict: 'wrong' as const,
        trackId: 't6',
        suggestedClass: 'neighbour',
        suggestedMacroClass: 'person' as const,
        suggestedLabel: 'neighbour',
      },
      review: reviewOf(),
    }
  }
  const workState =
    n % 3 === 0
      ? ('complete' as const)
      : n % 2 === 0
        ? ('annotated' as const)
        : ('unannotated' as const)
  return {
    ...base,
    complete: n % 3 === 0,
    workState,
    revision: 0,
    pipelineBoxes: [],
    dismissed: [],
  }
})

const VOCABULARY = ['postman', 'neighbour', 'gardener', 'courier'] as const

const OTHER_ANNOTATIONS: readonly RetrainAnnotation[] = FRAMES.slice(1, 5).map((f, i) => {
  const bbox = box(0.3, 0.3, 0.1, 0.3)
  return {
    id: `x${String(i)}`,
    deviceId: f.deviceId,
    mediaKey: f.frameId,
    bbox,
    macroClass: 'person' as const,
    label: VOCABULARY[i] ?? 'visitor',
    kind: 'subject' as const,
    source: 'operator' as const,
    origin: {
      source: 'operator' as const,
      ref: `operator:x${String(i)}`,
      bbox,
      macroClass: 'person' as const,
    },
    createdAt: NOW - 7_200_000,
  }
})

/** One running job eleven epochs in: the Jobs tab's detail shows the mAP sparkline. */
const RUNNING_JOB = {
  id: 'job-night-1',
  idempotencyKey: 'k-night-1',
  name: 'Night deliveries v2',
  createdAt: NOW - 3_000_000,
  updatedAt: NOW - 30_000,
  state: 'running',
  batchId: null,
  stage: 'train',
  failure: null,
  request: {
    selection: { collectionIds: ['col-1'], workState: 'complete' },
    entryId: 'modal-entry-default',
    gpuType: 'L4',
    region: '',
    baseModelId: 'yolov9m-640',
    preset: 'standard',
    freeze: null,
    holdoutCameras: null,
  },
  maxCostUsd: 3,
  maxRuntimeSec: 3600,
  trainer: { repo: 'example/trainer', revision: 'abcdef1' },
  datasetLayout: 'frames',
  frameCount: 5,
  frameIds: ['demo-frame-1'],
  annotationHash: 'h',
  dataset: null,
  split: { holdoutCameras: [], holdoutLastDays: 3, holdoutSupport: null, trainSubjects: 1 },
  provider: {
    state: 'running',
    providerJobId: 'p-1',
    startedAt: NOW - 2_900_000,
    endedAt: null,
    billedSeconds: 2_880,
    costUsd: 0.62,
    costIsEstimate: true,
    lastPolledAt: NOW - 30_000,
  },
  progress: {
    epoch: 11,
    epochs: 30,
    etaSec: 1_500,
    series: Array.from({ length: 11 }, (_v, i) => ({
      epoch: i + 1,
      map50: Math.round((0.31 + 0.4 * (1 - Math.exp(-i / 4)) + (i % 3) * 0.01) * 1000) / 1000,
      map50_95: null,
    })),
  },
  logTail: ['epoch 11/30  box_loss 1.21  cls_loss 0.84  mAP50 0.672'],
  logCursor: null,
  artifacts: null,
  cloudDatasetDeletedAt: null,
  cloudCleanupDueAt: null,
  registeredModelIds: [],
  canary: null,
}

export default defineFixtures({
  area: 'training',
  description:
    'Training addon, Frames tab: KPI, one collection, 8 frames (frame 1 has every review state)',
  handlers: {
    'deviceManager.listAll': CAMERA_IDS.map((id, i) => ({
      id,
      name: `Camera ${'ABC'[i] ?? 'X'}`,
      stableId: `demo-camera-${String(id)}`,
      addonId: 'demo-provider',
      disabled: false,
      type: 'camera',
      location: null,
      isCamera: true,
    })),
    'pipelineAnalytics.getRetrainCorpusKpi': {
      total: 8,
      unannotated: 3,
      annotated: 3,
      complete: 2,
      cameras: CAMERA_IDS.map((deviceId, i) => ({
        deviceId,
        unannotated: 1 + (i % 2),
        annotated: 1,
        complete: i === 0 ? 0 : 1,
        pctOfCorpus: i === 0 ? 0 : 0.125,
      })),
    },
    'pipelineAnalytics.listRetrainCollections': [
      { id: 'col-1', name: 'Night deliveries', createdAt: NOW - 86_400_000, frameCount: 5 },
    ],
    'pipelineAnalytics.listRetrainCorpusPage': (i: { page?: number; pageSize?: number }) => ({
      frames: FRAMES,
      total: FRAMES.length,
      page: i.page ?? 1,
      pageSize: i.pageSize ?? 50,
    }),
    'pipelineAnalytics.listRetrainAnnotations': (i: { frameIds?: readonly string[] }) => {
      const wanted = i.frameIds ?? []
      return [...OPEN_ANNOTATIONS, ...OTHER_ANNOTATIONS].filter((a) => wanted.includes(a.mediaKey))
    },
    'training.listJobs': [RUNNING_JOB],
    'training.listBaseModels': [],
    'trainingProvider.describe': [],
    'pipelineOrchestrator.getCameraStatuses': [],
    'pipelineOrchestrator.resolvePipeline': { steps: [] },
  },
})
