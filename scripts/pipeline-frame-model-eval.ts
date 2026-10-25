#!/usr/bin/env -S npx tsx
/**
 * Controlled object-detector evaluation for Pipeline frame lazy Task 1.
 *
 * Private images, downloaded models, overlays and raw results stay below
 * scratchpad/model-eval (gitignored). The aggregate Markdown report is safe to
 * version: it contains only corpus ids, measurements and artifact metadata.
 *
 * Commands:
 *   npx tsx scripts/pipeline-frame-model-eval.ts prepare
 *   npx tsx scripts/pipeline-frame-model-eval.ts dry-run
 *   npx tsx scripts/pipeline-frame-model-eval.ts fetch
 *   npx tsx scripts/pipeline-frame-model-eval.ts inspect
 *   npx tsx scripts/pipeline-frame-model-eval.ts transport
 *   npx tsx scripts/pipeline-frame-model-eval.ts benchmark --warmup 3 --iterations 10
 *   npx tsx scripts/pipeline-frame-model-eval.ts report
 *   npx tsx scripts/pipeline-frame-model-eval.ts all --warmup 3 --iterations 10
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SCRATCH = join(REPO, 'scratchpad', 'model-eval')
const IMAGE_DIR = join(SCRATCH, 'images')
const CACHE_DIR = join(SCRATCH, 'cache')
const OVERLAY_DIR = join(SCRATCH, 'overlays')
const RESULT_DIR = join(SCRATCH, 'results')
const MANIFEST_PATH = join(SCRATCH, 'manifest.json')
const VERSIONED_REPORT = join(REPO, 'docs', 'benchmarks', 'pipeline-frame-model-eval.md')
const POOL_SCRIPT = join(REPO, 'packages', 'addon-pipeline', 'python', 'inference_pool.py')

const CANDIDATE_THRESHOLD = 0.01
/** The floor the miss-dog-101 question is asked at: "under threshold, or absent?" */
const LOW_THRESHOLD = 0.1
const COMPARISON_THRESHOLD = 0.2
const CURRENT_ANIMAL_THRESHOLD = 0.5
const NMS_IOU_THRESHOLD = 0.45
const DEFAULT_PYTHON = '/opt/homebrew/opt/python@3.13/bin/python3.13'
const MLPACKAGE_FILES = [
  'Manifest.json',
  'Data/com.apple.CoreML/model.mlmodel',
  'Data/com.apple.CoreML/weights/weight.bin',
] as const

type PreprocessMode = 'resize' | 'letterbox'
type Scenario = 'production-equivalent' | 'common-resize' | 'common-letterbox'
type CorpusRole = 'miss' | 'control'
type Bbox = readonly [number, number, number, number]

export interface Detection {
  readonly class: string
  readonly score: number
  readonly bbox: Bbox
}

export interface CorpusItem {
  readonly id: string
  readonly filename: string
  readonly role: CorpusRole
  readonly label: string
  readonly currentThreshold: number
  readonly bbox?: Bbox
  readonly annotation?: string
  readonly sourcePath?: string
  /** Groups several frames into one named benchmark case (e.g. `miss-dog-101`). */
  readonly caseId?: string
  /**
   * Normalised `[x1, y1, x2, y2]` of the MOVING region the subject is in — the
   * stand-in for the runner's motion regions. When present the native-region
   * pass cuts a square around it at full resolution and runs the 320 model on
   * that, which is what the second-pass detection does live.
   */
  readonly nativeCropRegion?: Bbox
}

/** Pixel rectangle cut out of the full-resolution frame for the native-region pass. */
export interface NativeRegionCrop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export const MISS_DOG_101_CASE_ID = 'miss-dog-101'

/**
 * Smallest side of a native-region crop. At 4K a 320 model sees the frame at
 * 1/12 scale; a 640 px square is a 1/2 scale — the dog measured at
 * 89–277 px stays 45–140 px for the model, well inside what it detects.
 */
export const NATIVE_REGION_MIN_SIDE_PX = 640
/** Padding around the region before squaring, as a fraction of its larger side. */
export const NATIVE_REGION_PADDING_RATIO = 0.25

export interface CorpusManifest {
  readonly version: 1
  readonly note?: string
  readonly items: readonly CorpusItem[]
}

export interface GroundTruth {
  readonly label: string
  readonly bbox?: Bbox
  readonly annotation?: string
}

export interface BenchmarkCase {
  readonly modelId: ModelId
  readonly preprocessMode: PreprocessMode
  readonly scenarios: readonly Scenario[]
  readonly inputSize: 320 | 640
}

/**
 * The second-pass simulation: the production 320 letterbox model, fed a
 * native-resolution square around each item's `nativeCropRegion` instead of
 * the whole frame. Borrows the pool model already loaded for the
 * production-equivalent case (`poolModelIndex`), so no extra model is loaded.
 */
export interface NativeRegionCase extends BenchmarkCase {
  readonly source: 'native-region'
  readonly poolModelIndex: number
}

export interface ArtifactSpec {
  readonly modelId: ModelId
  readonly repo: string
  readonly treePath: string
  readonly packageName: string
  readonly inputSize: 320 | 640
}

type ModelId = 'scrypted-yolov9c-relu-test' | 'yolov9m-320' | 'yolov9m-640'

const PLUGIN_CATALOG_ANIMAL_CLASSES = new Set([
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
])

export function resolveTargetLabel(modelId: ModelId, sourceLabel: string): string {
  if (modelId === 'scrypted-yolov9c-relu-test' && PLUGIN_CATALOG_ANIMAL_CLASSES.has(sourceLabel)) {
    return 'animal'
  }
  return sourceLabel
}

/**
 * Square, full-resolution crop around a normalised region: padded by
 * {@link NATIVE_REGION_PADDING_RATIO}, grown to at least
 * {@link NATIVE_REGION_MIN_SIDE_PX}, and SHIFTED back inside the frame rather
 * than clamped — a clamped rectangle would change the scale the model sees.
 * A frame smaller than the floor yields the largest centred square it holds.
 */
export function planNativeRegionCrop(
  region: Bbox,
  frameWidth: number,
  frameHeight: number,
): NativeRegionCrop {
  const [nx1, ny1, nx2, ny2] = region
  const x1 = nx1 * frameWidth
  const y1 = ny1 * frameHeight
  const x2 = nx2 * frameWidth
  const y2 = ny2 * frameHeight
  const longest = Math.max(x2 - x1, y2 - y1)
  const padded = longest * (1 + 2 * NATIVE_REGION_PADDING_RATIO)
  const side = Math.round(
    Math.min(Math.max(padded, NATIVE_REGION_MIN_SIDE_PX), frameWidth, frameHeight),
  )
  const centreX = (x1 + x2) / 2
  const centreY = (y1 + y2) / 2
  const left = Math.round(Math.max(0, Math.min(frameWidth - side, centreX - side / 2)))
  const top = Math.round(Math.max(0, Math.min(frameHeight - side, centreY - side / 2)))
  return { left, top, width: side, height: side }
}

/** Crop-space boxes → frame-space boxes. The crop is unscaled, so it is an offset. */
export function offsetCropDetections(
  detections: readonly Detection[],
  crop: NativeRegionCrop,
): readonly Detection[] {
  return detections.map((detection) => {
    const [x1, y1, x2, y2] = detection.bbox
    return {
      ...detection,
      bbox: [x1 + crop.left, y1 + crop.top, x2 + crop.left, y2 + crop.top],
    }
  })
}

/** Every animal-class box at or above `threshold`, highest score first. */
export function animalDetectionsAtThreshold(
  detections: readonly Detection[],
  threshold: number,
): readonly Detection[] {
  return detections
    .filter(
      (detection) =>
        detection.score >= threshold &&
        (detection.class === 'animal' || PLUGIN_CATALOG_ANIMAL_CLASSES.has(detection.class)),
    )
    .toSorted((a, b) => b.score - a.score)
}

export function projectResizeDetections(
  detections: readonly Detection[],
  inputSize: number,
  originalWidth: number,
  originalHeight: number,
): readonly Detection[] {
  const scaleX = originalWidth / inputSize
  const scaleY = originalHeight / inputSize
  return detections.map((detection) => {
    const [x1, y1, x2, y2] = detection.bbox
    return {
      ...detection,
      bbox: [
        Math.max(0, Math.min(originalWidth, x1 * scaleX)),
        Math.max(0, Math.min(originalHeight, y1 * scaleY)),
        Math.max(0, Math.min(originalWidth, x2 * scaleX)),
        Math.max(0, Math.min(originalHeight, y2 * scaleY)),
      ],
    }
  })
}

const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    modelId: 'scrypted-yolov9c-relu-test',
    repo: 'scrypted/plugin-models',
    treePath: 'coreml/scrypted_yolov9c_relu_test/scrypted_yolov9c_relu_test.mlpackage',
    packageName: 'scrypted_yolov9c_relu_test.mlpackage',
    inputSize: 320,
  },
  {
    modelId: 'yolov9m-320',
    repo: 'camstack/camstack-models',
    treePath: 'objectDetection/yolov9/coreml/camstack-yolov9m-320.mlpackage',
    packageName: 'camstack-yolov9m-320.mlpackage',
    inputSize: 320,
  },
  {
    modelId: 'yolov9m-640',
    repo: 'camstack/camstack-models',
    treePath: 'objectDetection/yolov9/coreml/camstack-yolov9m-640.mlpackage',
    packageName: 'camstack-yolov9m-640.mlpackage',
    inputSize: 640,
  },
]

/**
 * Camera 101 (Hikvision 4K, 3840×2160): three key frames where a dog was in
 * the scene and the live pipeline emitted NO `animal` detection at all (the
 * confirmation gate later saw the animal at 0.74–0.91 inside a PERSON crop).
 * Boxes are hand-read off the key frame at 1/3 scale (±30 px), so recovery is
 * scored by class presence + box overlap rather than a strict IoU.
 */
const DOG_101_SOURCES: readonly CorpusItem[] = [
  {
    id: 'miss-dog-101-a',
    caseId: MISS_DOG_101_CASE_ID,
    filename: 'miss-dog-101-a.jpg',
    sourcePath: join(REPO, 'scratchpad', '_inv_media', '125c8612_keyFrame.jpg'),
    role: 'miss',
    label: 'dog',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    bbox: [2550, 585, 2880, 795],
    nativeCropRegion: [0.59, 0.04, 0.78, 0.39],
    annotation:
      'track:125c8612 keyFrame, 2026-09-06 14:30Z — man in red with a dark dog on a lead.',
  },
  {
    id: 'miss-dog-101-b',
    caseId: MISS_DOG_101_CASE_ID,
    filename: 'miss-dog-101-b.jpg',
    sourcePath: join(REPO, 'scratchpad', '_inv_media', 'a38098cb_keyFrame.jpg'),
    role: 'miss',
    label: 'dog',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    bbox: [2685, 495, 2850, 101],
    nativeCropRegion: [0.62, 0.03, 0.84, 0.33],
    annotation:
      'track:a38098cb keyFrame, 2026-09-06 11:49Z — two people and a small white dog between them.',
  },
  {
    id: 'miss-dog-101-c',
    caseId: MISS_DOG_101_CASE_ID,
    filename: 'miss-dog-101-c.jpg',
    sourcePath: join(REPO, 'scratchpad', '_inv_media', 'e5d943a1_keyFrame.jpg'),
    role: 'miss',
    label: 'dog',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    bbox: [930, 405, 1290, 735],
    nativeCropRegion: [0.16, 0.01, 0.34, 0.35],
    annotation: 'track:e5d943a1 keyFrame, 2026-09-04 11:12Z — woman walking a white dog.',
  },
]

export const CORPUS_SOURCES: readonly CorpusItem[] = [
  {
    id: 'miss-cat-suvfront',
    filename: 'miss-cat-suvfront.jpg',
    sourcePath: '/tmp/cat-crop-4k-suvfront.jpg',
    role: 'miss',
    label: 'cat',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    annotation:
      'Cat in the upper-centre pavement area. No exact bbox is asserted because only the crop, not the originating annotation, is available.',
  },
  {
    id: 'miss-bird-sidewalk',
    filename: 'miss-bird-sidewalk.jpg',
    sourcePath: '/tmp/bird-crop-sidewalk.jpg',
    role: 'miss',
    label: 'bird',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    annotation:
      'Bird in the sidewalk crop. No exact bbox is asserted because the source annotation is unavailable and the target is very small.',
  },
  {
    id: 'miss-cat-t820',
    filename: 'miss-cat-t820.jpg',
    sourcePath: '/tmp/t820-firstFrame-0.jpg',
    role: 'miss',
    label: 'cat',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    annotation:
      'Small cat below the SUV front area. The visible green vehicle box is not target ground truth; no cat bbox is invented.',
  },
  {
    id: 'control-plugin-catalog-cat',
    filename: 'control-plugin-catalog-cat.jpg',
    sourcePath: '/tmp/plugin-catalog-cat.jpg',
    role: 'control',
    label: 'cat',
    currentThreshold: CURRENT_ANIMAL_THRESHOLD,
    annotation:
      'Black cat on the upper-right pavement. Positive control; no originating detector bbox is available.',
  },
  ...DOG_101_SOURCES,
]

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] ?? 0
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function bboxIou(a: Bbox, b: Bbox): number {
  const intersectionWidth = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const intersectionHeight = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const intersection = intersectionWidth * intersectionHeight
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const union = areaA + areaB - intersection
  return union > 0 ? intersection / union : 0
}

interface ThresholdEvaluation {
  readonly threshold: number
  readonly recovered: boolean
  readonly bestScore: number | null
  readonly bestIou: number | null
  readonly falsePositives: number | null
  readonly detections: readonly Detection[]
}

/** Overlap needed for a hand-read box to count as "the same subject". */
const OVERLAP_RECOVERY_IOU = 0.3

function evaluateAtThreshold(
  candidates: readonly Detection[],
  groundTruth: GroundTruth,
  threshold: number,
): ThresholdEvaluation {
  const detections = candidates.filter((detection) => detection.score >= threshold)
  const matching = detections.filter((detection) => detection.class === groundTruth.label)
  const bestScore =
    matching.length > 0 ? Math.max(...matching.map((detection) => detection.score)) : null
  if (!groundTruth.bbox) {
    return {
      threshold,
      recovered: matching.length > 0,
      bestScore,
      bestIou: null,
      falsePositives: null,
      detections,
    }
  }

  const ious = matching.map((detection) => bboxIou(detection.bbox, groundTruth.bbox as Bbox))
  const bestIou = ious.length > 0 ? Math.max(...ious) : 0
  const truePositiveIndexes = new Set(
    ious
      .map((iou, index) => ({ iou, index }))
      .filter(({ iou }) => iou >= 0.5)
      .map(({ index }) => index),
  )
  const falsePositives =
    detections.filter((detection) => detection.class !== groundTruth.label).length +
    matching.filter((_, index) => !truePositiveIndexes.has(index)).length

  return {
    threshold,
    recovered: bestIou >= 0.5,
    bestScore,
    bestIou,
    falsePositives,
    detections,
  }
}

export function evaluateImageDetections(
  detections: readonly Detection[],
  groundTruth: GroundTruth,
  currentThreshold: number,
): {
  readonly candidates: readonly Detection[]
  readonly at010: ThresholdEvaluation
  readonly at020: ThresholdEvaluation
  readonly atCurrent: ThresholdEvaluation
} {
  const candidates = detections.filter((detection) => detection.score >= CANDIDATE_THRESHOLD)
  return {
    candidates,
    at010: evaluateAtThreshold(candidates, groundTruth, LOW_THRESHOLD),
    at020: evaluateAtThreshold(candidates, groundTruth, COMPARISON_THRESHOLD),
    atCurrent: evaluateAtThreshold(candidates, groundTruth, currentThreshold),
  }
}

/**
 * The miss-dog-101 verdict for one (frame, configuration): every animal-class
 * box at the low threshold, and whether one of them overlaps the hand-read dog
 * box at all. Distinct from {@link evaluateImageDetections}'s strict-IoU
 * recovery because the boxes here are read off a downscaled preview.
 */
export function evaluateAnimalRecovery(
  detections: readonly Detection[],
  target: Bbox | undefined,
): {
  readonly animalsAtLow: readonly Detection[]
  readonly bestOverlappingScore: number | null
  readonly bestOverlappingClass: string | null
} {
  const animalsAtLow = animalDetectionsAtThreshold(detections, LOW_THRESHOLD)
  if (!target) return { animalsAtLow, bestOverlappingScore: null, bestOverlappingClass: null }
  const overlapping = animalsAtLow.filter(
    (detection) => bboxIou(detection.bbox, target) >= OVERLAP_RECOVERY_IOU,
  )
  const best = overlapping[0]
  return {
    animalsAtLow,
    bestOverlappingScore: best ? best.score : null,
    bestOverlappingClass: best ? best.class : null,
  }
}

export function validateCorpusManifest(manifest: CorpusManifest): void {
  if (manifest.version !== 1)
    throw new Error(`unsupported corpus manifest version ${manifest.version}`)
  const ids = new Set<string>()
  let misses = 0
  let controls = 0
  for (const item of manifest.items) {
    if (ids.has(item.id)) throw new Error(`duplicate corpus id ${item.id}`)
    ids.add(item.id)
    if (!item.bbox && !item.annotation?.trim()) {
      throw new Error(`${item.id} requires bbox or explicit annotation`)
    }
    if (item.role === 'miss') misses += 1
    else controls += 1
    if (!(item.currentThreshold >= 0 && item.currentThreshold <= 1)) {
      throw new Error(`${item.id} currentThreshold must be in [0,1]`)
    }
  }
  // A control is welcome but not required: the miss-dog-101 case is a set of
  // misses from one camera, and the original four-image corpus sources are
  // not on every machine this runs on.
  if (misses < 1) {
    throw new Error(
      `corpus requires at least one miss, found ${misses} misses / ${controls} controls`,
    )
  }
}

export function buildNativeRegionCase(): NativeRegionCase {
  const cases = buildBenchmarkCases()
  const poolModelIndex = cases.findIndex(
    (entry) => entry.modelId === 'yolov9m-320' && entry.preprocessMode === 'letterbox',
  )
  if (poolModelIndex < 0) throw new Error('production-equivalent yolov9m-320 case is missing')
  return {
    modelId: 'yolov9m-320',
    preprocessMode: 'letterbox',
    scenarios: ['production-equivalent'],
    inputSize: 320,
    source: 'native-region',
    poolModelIndex,
  }
}

export function buildBenchmarkCases(): readonly BenchmarkCase[] {
  return [
    {
      modelId: 'scrypted-yolov9c-relu-test',
      preprocessMode: 'resize',
      scenarios: ['production-equivalent', 'common-resize'],
      inputSize: 320,
    },
    {
      modelId: 'scrypted-yolov9c-relu-test',
      preprocessMode: 'letterbox',
      scenarios: ['common-letterbox'],
      inputSize: 320,
    },
    {
      modelId: 'yolov9m-320',
      preprocessMode: 'letterbox',
      scenarios: ['production-equivalent', 'common-letterbox'],
      inputSize: 320,
    },
    {
      modelId: 'yolov9m-320',
      preprocessMode: 'resize',
      scenarios: ['common-resize'],
      inputSize: 320,
    },
    {
      modelId: 'yolov9m-640',
      preprocessMode: 'letterbox',
      scenarios: ['production-equivalent', 'common-letterbox'],
      inputSize: 640,
    },
    {
      modelId: 'yolov9m-640',
      preprocessMode: 'resize',
      scenarios: ['common-resize'],
      inputSize: 640,
    },
  ]
}

export interface ResolutionDecisionInput {
  readonly recoveredMisses: number
  readonly totalMisses: number
  readonly controlRegressed: boolean
  readonly falsePositivesRegressed: boolean | null
  readonly realConcurrency: number | null
  readonly capacityNMax640: number | null
}

export function assessResolutionDecision(input: ResolutionDecisionInput): {
  readonly recommend640: boolean
  readonly reasons: readonly string[]
} {
  const reasons: string[] = []
  if (input.recoveredMisses < 2) {
    reasons.push(
      `640 recovered ${input.recoveredMisses}/${input.totalMisses} misses; at least 2 are required`,
    )
  }
  if (input.controlRegressed) reasons.push('640 regressed on the positive control')
  if (input.falsePositivesRegressed === true) reasons.push('640 regressed on false positives')
  if (input.falsePositivesRegressed === null) {
    reasons.push(
      'false-positive regression is unassessed because exact ground-truth boxes are unavailable',
    )
  }
  if (input.realConcurrency === null || input.capacityNMax640 === null) {
    reasons.push('real concurrency or 640 capacity result is unavailable')
  } else {
    const requiredCapacity = Math.ceil(input.realConcurrency * 1.25)
    if (input.capacityNMax640 < requiredCapacity) {
      reasons.push(
        `640 capacity ${input.capacityNMax640} is below the required ${requiredCapacity} for 25% headroom over concurrency ${input.realConcurrency}`,
      )
    }
  }
  return { recommend640: reasons.length === 0, reasons }
}

interface TransportSample {
  readonly jpegBytes: number
  readonly rawMaterializeMs: number
  readonly jpegEncodeMs: number
}

export function summariseTransportSamples(
  width: number,
  height: number,
  samples: readonly TransportSample[],
) {
  const jpegBytes = samples.map((sample) => sample.jpegBytes)
  const rawMs = samples.map((sample) => sample.rawMaterializeMs)
  const jpegMs = samples.map((sample) => sample.jpegEncodeMs)
  return {
    width,
    height,
    rawBytes: width * height * 3,
    jpegBytesMedian: percentile(jpegBytes, 0.5),
    jpegBytesP95: percentile(jpegBytes, 0.95),
    rawMaterializeMsMedian: round(percentile(rawMs, 0.5)),
    rawMaterializeMsP95: round(percentile(rawMs, 0.95)),
    jpegEncodeMsMedian: round(percentile(jpegMs, 0.5)),
    jpegEncodeMsP95: round(percentile(jpegMs, 0.95)),
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function writeTextAtomic(path: string, value: string, mode = 0o600): void {
  ensureDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, value, { mode })
  renameSync(temporary, path)
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readManifest(): CorpusManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`private corpus manifest missing: run the prepare command (${MANIFEST_PATH})`)
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CorpusManifest
  validateCorpusManifest(manifest)
  for (const item of manifest.items) {
    const path = join(IMAGE_DIR, item.filename)
    if (!existsSync(path)) throw new Error(`corpus image missing for ${item.id}: ${path}`)
  }
  return manifest
}

function prepareCorpus(): CorpusManifest {
  ensureDirectory(IMAGE_DIR)
  const items: CorpusItem[] = []
  for (const item of CORPUS_SOURCES) {
    if (!item.sourcePath || !existsSync(item.sourcePath)) {
      // Named, never silent: a case that is not on this machine must read as
      // "not measured here", not as "measured and empty".
      process.stderr.write(
        `skipping ${item.id}: approved source missing (${item.sourcePath ?? 'unset'})\n`,
      )
      continue
    }
    copyFileSync(item.sourcePath, join(IMAGE_DIR, item.filename))
    items.push(item)
  }
  const manifest: CorpusManifest = {
    version: 1,
    note: 'Private approved corpus. Annotation-only targets intentionally omit bbox/IoU rather than invent coordinates.',
    items,
  }
  validateCorpusManifest(manifest)
  writeJsonAtomic(MANIFEST_PATH, manifest)
  return manifest
}

interface HuggingFaceTreeItem {
  readonly type: 'file' | 'directory'
  readonly path: string
  readonly size?: number
  readonly lfs?: { readonly oid?: string; readonly size?: number }
}

export function validateHfRelativePath(value: string, context: string): string {
  const segments = value.split('/')
  if (
    value.length === 0 ||
    posix.isAbsolute(value) ||
    value.includes('\\') ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error(`${context} must be a safe relative Hugging Face path: ${value}`)
  }
  return value
}

async function fetchTree(spec: ArtifactSpec): Promise<readonly HuggingFaceTreeItem[]> {
  const repo = validateHfRelativePath(spec.repo, `${spec.modelId} repository`)
  const treePath = validateHfRelativePath(spec.treePath, `${spec.modelId} tree path`)
  const url = `https://huggingface.co/api/models/${repo}/tree/main/${treePath}?recursive=true&expand=true`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Hugging Face tree ${spec.modelId}: HTTP ${response.status}`)
  return (await response.json()) as readonly HuggingFaceTreeItem[]
}

function artifactPackagePath(spec: ArtifactSpec): string {
  return join(CACHE_DIR, spec.modelId, spec.packageName)
}

function artifactRelativePath(spec: ArtifactSpec, remotePath: string): string {
  const treePath = validateHfRelativePath(spec.treePath, `${spec.modelId} tree path`)
  const safeRemotePath = validateHfRelativePath(remotePath, `${spec.modelId} remote path`)
  const prefix = `${treePath}/`
  if (!safeRemotePath.startsWith(prefix)) {
    throw new Error(`artifact ${remotePath} is outside expected tree ${spec.treePath}`)
  }
  return validateHfRelativePath(
    safeRemotePath.slice(prefix.length),
    `${spec.modelId} artifact relative path`,
  )
}

async function downloadFile(url: string, target: string, expectedBytes?: number): Promise<void> {
  if (
    existsSync(target) &&
    (expectedBytes === undefined || statSync(target).size === expectedBytes)
  ) {
    return
  }
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download ${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new Error(`download ${url}: expected ${expectedBytes} bytes, received ${bytes.length}`)
  }
  ensureDirectory(dirname(target))
  const temporary = `${target}.tmp-${process.pid}`
  writeFileSync(temporary, bytes, { mode: 0o600 })
  renameSync(temporary, target)
}

async function fetchArtifacts(): Promise<void> {
  for (const spec of ARTIFACTS) {
    const tree = await fetchTree(spec)
    const files = tree.filter((item) => item.type === 'file')
    const gotRelative = files.map((item) => artifactRelativePath(spec, item.path)).toSorted()
    const expectedRelative = [...MLPACKAGE_FILES].toSorted()
    if (JSON.stringify(gotRelative) !== JSON.stringify(expectedRelative)) {
      throw new Error(
        `${spec.modelId} mlpackage layout changed: expected ${expectedRelative.join(', ')}, got ${gotRelative.join(', ')}`,
      )
    }
    for (const file of files) {
      const relativePath = artifactRelativePath(spec, file.path)
      const target = join(artifactPackagePath(spec), ...relativePath.split('/'))
      const repo = validateHfRelativePath(spec.repo, `${spec.modelId} repository`)
      const remotePath = validateHfRelativePath(file.path, `${spec.modelId} remote path`)
      const url = `https://huggingface.co/${repo}/resolve/main/${remotePath}`
      await downloadFile(url, target, file.size ?? file.lfs?.size)
    }
  }
}

export function resolveArtifactSpec(modelId: string): ArtifactSpec {
  const artifact = ARTIFACTS.find((candidate) => candidate.modelId === modelId)
  if (!artifact) throw new Error(`benchmark model ${modelId} has no artifact definition`)
  return artifact
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface CoreMlFeature {
  readonly name: string
  readonly type: string
  readonly shape?: readonly number[]
}

interface CoreMlSpecInspection {
  readonly specificationVersion: number
  readonly inputs: readonly CoreMlFeature[]
  readonly outputs: readonly CoreMlFeature[]
  readonly metadata: Readonly<Record<string, string>>
}

function inspectCoreMlSpec(pythonPath: string, packagePath: string): CoreMlSpecInspection | null {
  const source = String.raw`
import coremltools as ct, json, sys
spec = ct.utils.load_spec(sys.argv[1])
def feature(f):
    t = f.type.WhichOneof("Type")
    out = {"name": f.name, "type": t}
    if t == "multiArrayType":
        out["shape"] = list(f.type.multiArrayType.shape)
    elif t == "imageType":
        out["shape"] = [f.type.imageType.height, f.type.imageType.width]
    return out
print(json.dumps({
    "specificationVersion": spec.specificationVersion,
    "inputs": [feature(f) for f in spec.description.input],
    "outputs": [feature(f) for f in spec.description.output],
    "metadata": dict(spec.description.metadata.userDefined),
}))
`
  const result = spawnSync(pythonPath, ['-c', source, packagePath], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.status !== 0) return null
  const line = result.stdout
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.startsWith('{'))
  return line ? (JSON.parse(line) as CoreMlSpecInspection) : null
}

interface ArtifactInspection {
  readonly modelId: ModelId
  readonly repo: string
  readonly treePath: string
  readonly packagePath: string
  readonly bytes: number
  readonly files: ReadonlyArray<{ path: string; bytes: number; sha256: string }>
  readonly coremlSpec: CoreMlSpecInspection | null
}

function inspectArtifacts(pythonPath: string): readonly ArtifactInspection[] {
  return ARTIFACTS.map((spec) => {
    const packagePath = artifactPackagePath(spec)
    const files = MLPACKAGE_FILES.map((file) => {
      const path = join(packagePath, ...file.split('/'))
      if (!existsSync(path)) throw new Error(`${spec.modelId} cache is incomplete: missing ${file}`)
      return {
        path: file,
        bytes: statSync(path).size,
        sha256: sha256(path),
      }
    })
    return {
      modelId: spec.modelId,
      repo: spec.repo,
      treePath: spec.treePath,
      packagePath,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
      coremlSpec: inspectCoreMlSpec(pythonPath, packagePath),
    }
  })
}

async function measureTransport(
  manifest: CorpusManifest,
  iterations: number,
): Promise<readonly ReturnType<typeof summariseTransportSamples>[]> {
  const results = []
  for (const [width, height] of [
    [320, 180],
    [640, 360],
  ] as const) {
    const samples: TransportSample[] = []
    for (const item of manifest.items) {
      const imagePath = join(IMAGE_DIR, item.filename)
      for (let iteration = -2; iteration < iterations; iteration += 1) {
        let started = performance.now()
        const raw = await sharp(imagePath)
          .resize(width, height, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer()
        const rawMaterializeMs = performance.now() - started
        if (raw.length !== width * height * 3) {
          throw new Error(`${item.id} ${width}x${height}: expected RGB raw payload`)
        }
        started = performance.now()
        const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
          .jpeg({ quality: 90, chromaSubsampling: '4:2:0' })
          .toBuffer()
        const jpegEncodeMs = performance.now() - started
        if (iteration >= 0) samples.push({ jpegBytes: jpeg.length, rawMaterializeMs, jpegEncodeMs })
      }
    }
    results.push(summariseTransportSamples(width, height, samples))
  }
  return results
}

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

class InferencePoolClient {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private stdoutBuffer = Buffer.alloc(0)
  private stderr = ''

  constructor(pythonPath: string) {
    this.process = spawn(pythonPath, [POOL_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-64_000)
    })
    this.process.on('exit', (code) => {
      const error = new Error(`inference pool exited ${code}: ${this.stderr.slice(-4000)}`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    while (this.stdoutBuffer.length >= 4) {
      const bodyLength = this.stdoutBuffer.readUInt32LE(0)
      if (this.stdoutBuffer.length < bodyLength + 4) return
      const body = this.stdoutBuffer.subarray(4, bodyLength + 4)
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyLength + 4)
      const requestId = body.readUInt32LE(0)
      const pending = this.pending.get(requestId)
      if (!pending) continue
      this.pending.delete(requestId)
      try {
        pending.resolve(JSON.parse(body.subarray(4).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private request(
    requestId: number,
    messageType: number,
    payload: Buffer,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
      const bodyLength = 4 + 1 + payload.length
      const header = Buffer.allocUnsafe(9)
      header.writeUInt32LE(bodyLength, 0)
      header.writeUInt32LE(requestId, 4)
      header[8] = messageType
      this.process.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return
        this.pending.delete(requestId)
        rejectRequest(error)
      })
    })
  }

  async start(cases: readonly BenchmarkCase[]): Promise<void> {
    const models = cases.map((benchmarkCase) => {
      const isPluginCatalog = benchmarkCase.modelId === 'scrypted-yolov9c-relu-test'
      return {
        path: artifactPackagePath(resolveArtifactSpec(benchmarkCase.modelId)),
        inputSize: benchmarkCase.inputSize,
        preprocessMode: benchmarkCase.preprocessMode,
        postprocessor: 'yolo',
        confidence: CANDIDATE_THRESHOLD,
        nmsIouThreshold: NMS_IOU_THRESHOLD,
        ...(isPluginCatalog ? { labels: ['person', 'vehicle', 'animal'], numClasses: 3 } : {}),
      }
    })
    const ready = await this.request(
      0,
      0,
      Buffer.from(JSON.stringify({ runtime: 'coreml', concurrency: 1, models }), 'utf8'),
    )
    if (ready.status !== 'ready' || ready.models !== models.length) {
      throw new Error(`CoreML pool did not load all models: ${JSON.stringify(ready)}`)
    }
  }

  inferJpeg(modelIndex: number, jpeg: Buffer): Promise<Record<string, unknown>> {
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    return this.request(requestId, 1, Buffer.concat([Buffer.from([modelIndex]), jpeg]))
  }

  inferRaw(
    modelIndex: number,
    raw: Buffer,
    width: number,
    height: number,
  ): Promise<Record<string, unknown>> {
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    const metadata = Buffer.allocUnsafe(10)
    metadata[0] = modelIndex
    metadata.writeUInt32LE(width, 1)
    metadata.writeUInt32LE(height, 5)
    metadata[9] = 0
    return this.request(requestId, 2, Buffer.concat([metadata, raw]))
  }

  async close(): Promise<void> {
    this.process.stdin.end()
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.process.kill('SIGKILL')
        resolveClose()
      }, 5_000)
      this.process.once('exit', () => {
        clearTimeout(timer)
        resolveClose()
      })
    })
  }
}

function parseDetections(response: Record<string, unknown>): readonly Detection[] {
  const detections = response.detections
  if (!Array.isArray(detections)) return []
  return detections.flatMap((raw): readonly Detection[] => {
    if (!raw || typeof raw !== 'object') return []
    const value = raw as Record<string, unknown>
    if (
      typeof value.class !== 'string' ||
      typeof value.score !== 'number' ||
      !Array.isArray(value.bbox) ||
      value.bbox.length !== 4 ||
      !value.bbox.every((coordinate) => typeof coordinate === 'number')
    ) {
      return []
    }
    return [
      {
        class: value.class,
        score: value.score,
        bbox: value.bbox as unknown as Bbox,
      },
    ]
  })
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function writeOverlay(
  inputPath: string,
  outputPath: string,
  detections: readonly Detection[],
  item: CorpusItem,
): Promise<void> {
  const metadata = await sharp(inputPath).metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const elements = detections.map((detection, index) => {
    const [x1, y1, x2, y2] = detection.bbox
    const color = detection.class === item.label ? '#00ff66' : '#ff4d4d'
    const y = Math.max(14, y1 - 3)
    return `<rect x="${x1}" y="${y1}" width="${Math.max(0, x2 - x1)}" height="${Math.max(0, y2 - y1)}" fill="none" stroke="${color}" stroke-width="2"/>
<text x="${x1 + 2}" y="${y}" font-size="13" font-family="sans-serif" fill="${color}">${escapeXml(`${index + 1} ${detection.class} ${detection.score.toFixed(3)}`)}</text>`
  })
  if (item.bbox) {
    const [x1, y1, x2, y2] = item.bbox
    elements.push(
      `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="#00b7ff" stroke-width="3" stroke-dasharray="5,3"/>`,
    )
  }
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`,
  )
  ensureDirectory(dirname(outputPath))
  await sharp(inputPath)
    .composite([{ input: svg }])
    .jpeg({ quality: 92 })
    .toFile(outputPath)
}

interface ImageBenchmarkResult {
  readonly itemId: string
  readonly targetLabel: string
  readonly latencyMs: { readonly median: number; readonly p95: number }
  readonly evaluation: ReturnType<typeof evaluateImageDetections>
  /** The miss-dog-101 verdict — animal boxes at 0.10 and overlap with the hand-read box. */
  readonly animalRecovery: ReturnType<typeof evaluateAnimalRecovery>
  /** The native square this pass ran on; absent on a full-frame pass. */
  readonly nativeCrop?: NativeRegionCrop
}

interface ModelBenchmarkResult {
  readonly modelId: ModelId
  readonly preprocessMode: PreprocessMode
  readonly scenarios: readonly Scenario[]
  readonly inputSize: number
  /** Absent means the whole frame (the historical result shape). */
  readonly source?: 'full-frame' | 'native-region'
  readonly images: readonly ImageBenchmarkResult[]
}

/**
 * One item of the native-region pass: cut the square at full resolution, run
 * the already-loaded production 320 model on it, put the boxes back in frame
 * space. Returns `null` for an item that declares no region.
 */
async function benchmarkNativeRegionItem(
  client: InferencePoolClient,
  nativeCase: NativeRegionCase,
  item: CorpusItem,
  warmup: number,
  iterations: number,
): Promise<ImageBenchmarkResult | null> {
  if (!item.nativeCropRegion) return null
  const imagePath = join(IMAGE_DIR, item.filename)
  const metadata = await sharp(imagePath).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) throw new Error(`${item.id}: unreadable dimensions`)
  const crop = planNativeRegionCrop(item.nativeCropRegion, width, height)
  const cropJpeg = await sharp(imagePath).extract(crop).jpeg({ quality: 90 }).toBuffer()
  for (let index = 0; index < warmup; index += 1) {
    await client.inferJpeg(nativeCase.poolModelIndex, cropJpeg)
  }
  const latency: number[] = []
  let response: Record<string, unknown> = {}
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    response = await client.inferJpeg(nativeCase.poolModelIndex, cropJpeg)
    latency.push(performance.now() - started)
  }
  const detections = offsetCropDetections(parseDetections(response), crop)
  const targetLabel = resolveTargetLabel(nativeCase.modelId, item.label)
  const evaluation = evaluateImageDetections(
    detections,
    { label: targetLabel, bbox: item.bbox, annotation: item.annotation },
    item.currentThreshold,
  )
  await writeOverlay(
    imagePath,
    join(
      OVERLAY_DIR,
      `${nativeCase.modelId}-${nativeCase.preprocessMode}-native-region`,
      item.filename,
    ),
    evaluation.candidates,
    { ...item, label: targetLabel },
  )
  return {
    itemId: item.id,
    targetLabel,
    latencyMs: { median: round(percentile(latency, 0.5)), p95: round(percentile(latency, 0.95)) },
    evaluation,
    animalRecovery: evaluateAnimalRecovery(detections, item.bbox),
    nativeCrop: crop,
  }
}

interface RouteBenchmarkResult {
  readonly modelId: ModelId
  readonly width: number
  readonly height: number
  readonly format: 'raw' | 'jpeg'
  readonly payloadBytesMedian: number
  readonly payloadBytesP95: number
  readonly e2eMsMedian: number
  readonly e2eMsP95: number
}

async function runModelBenchmark(
  manifest: CorpusManifest,
  pythonPath: string,
  warmup: number,
  iterations: number,
): Promise<{
  readonly cases: readonly ModelBenchmarkResult[]
  readonly routes: readonly RouteBenchmarkResult[]
}> {
  const cases = buildBenchmarkCases()
  const client = new InferencePoolClient(pythonPath)
  await client.start(cases)
  try {
    const results: ModelBenchmarkResult[] = []
    for (let modelIndex = 0; modelIndex < cases.length; modelIndex += 1) {
      const benchmarkCase = cases[modelIndex] as BenchmarkCase
      const images: ImageBenchmarkResult[] = []
      for (const item of manifest.items) {
        const imagePath = join(IMAGE_DIR, item.filename)
        const jpeg = readFileSync(imagePath)
        for (let index = 0; index < warmup; index += 1) {
          await client.inferJpeg(modelIndex, jpeg)
        }
        const latency: number[] = []
        let response: Record<string, unknown> = {}
        for (let index = 0; index < iterations; index += 1) {
          const started = performance.now()
          response = await client.inferJpeg(modelIndex, jpeg)
          latency.push(performance.now() - started)
        }
        const parsedDetections = parseDetections(response)
        const metadata = await sharp(imagePath).metadata()
        const detections =
          benchmarkCase.preprocessMode === 'resize'
            ? projectResizeDetections(
                parsedDetections,
                benchmarkCase.inputSize,
                metadata.width ?? benchmarkCase.inputSize,
                metadata.height ?? benchmarkCase.inputSize,
              )
            : parsedDetections
        const targetLabel = resolveTargetLabel(benchmarkCase.modelId, item.label)
        const evaluation = evaluateImageDetections(
          detections,
          { label: targetLabel, bbox: item.bbox, annotation: item.annotation },
          item.currentThreshold,
        )
        await writeOverlay(
          imagePath,
          join(
            OVERLAY_DIR,
            `${benchmarkCase.modelId}-${benchmarkCase.preprocessMode}`,
            item.filename,
          ),
          evaluation.candidates,
          { ...item, label: targetLabel },
        )
        images.push({
          itemId: item.id,
          targetLabel,
          latencyMs: {
            median: round(percentile(latency, 0.5)),
            p95: round(percentile(latency, 0.95)),
          },
          evaluation,
          animalRecovery: evaluateAnimalRecovery(detections, item.bbox),
        })
      }
      results.push({ ...benchmarkCase, source: 'full-frame', images })
    }

    // The second-pass simulation, on the items that declare a moving region.
    const nativeCase = buildNativeRegionCase()
    const nativeImages: ImageBenchmarkResult[] = []
    for (const item of manifest.items) {
      const image = await benchmarkNativeRegionItem(client, nativeCase, item, warmup, iterations)
      if (image) nativeImages.push(image)
    }
    if (nativeImages.length > 0) {
      const { poolModelIndex: _poolModelIndex, ...nativeShape } = nativeCase
      results.push({ ...nativeShape, images: nativeImages })
    }

    const routes: RouteBenchmarkResult[] = []
    for (const route of [
      { modelId: 'yolov9m-320' as const, width: 320, height: 180 },
      { modelId: 'yolov9m-640' as const, width: 640, height: 360 },
    ]) {
      const modelIndex = cases.findIndex(
        (entry) => entry.modelId === route.modelId && entry.preprocessMode === 'letterbox',
      )
      for (const format of ['raw', 'jpeg'] as const) {
        const payloadBytes: number[] = []
        const e2eMs: number[] = []
        for (const item of manifest.items) {
          const raw = await sharp(join(IMAGE_DIR, item.filename))
            .resize(route.width, route.height, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer()
          const jpeg = await sharp(raw, {
            raw: { width: route.width, height: route.height, channels: 3 },
          })
            .jpeg({ quality: 90, chromaSubsampling: '4:2:0' })
            .toBuffer()
          for (let index = 0; index < warmup; index += 1) {
            if (format === 'raw') {
              await client.inferRaw(modelIndex, raw, route.width, route.height)
            } else {
              await client.inferJpeg(modelIndex, jpeg)
            }
          }
          for (let index = 0; index < iterations; index += 1) {
            const started = performance.now()
            if (format === 'raw') {
              await client.inferRaw(modelIndex, raw, route.width, route.height)
            } else {
              await client.inferJpeg(modelIndex, jpeg)
            }
            e2eMs.push(performance.now() - started)
            payloadBytes.push(format === 'raw' ? raw.length : jpeg.length)
          }
        }
        routes.push({
          ...route,
          format,
          payloadBytesMedian: percentile(payloadBytes, 0.5),
          payloadBytesP95: percentile(payloadBytes, 0.95),
          e2eMsMedian: round(percentile(e2eMs, 0.5)),
          e2eMsP95: round(percentile(e2eMs, 0.95)),
        })
      }
    }
    return { cases: results, routes }
  } finally {
    await client.close()
  }
}

function captureCommand(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? result.stdout.trim() : null
}

function environmentSnapshot(pythonPath: string) {
  return {
    recordedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    macos: captureCommand('sw_vers', ['-productVersion']),
    hardware: captureCommand('sysctl', ['-n', 'machdep.cpu.brand_string']),
    python: captureCommand(pythonPath, ['--version']),
    coremltools: captureCommand(pythonPath, [
      '-c',
      'import coremltools; print(coremltools.__version__)',
    ]),
    sharp: sharp.versions,
    coremlComputeUnits:
      'ALL (CoreML chooses CPU/GPU/ANE; no private API is used to claim per-op placement)',
  }
}

export function deriveDecision(
  manifest: CorpusManifest,
  modelResults: readonly ModelBenchmarkResult[] | null,
  capacity: { readonly realConcurrency: number; readonly capacityNMax640: number } | null,
) {
  if (!modelResults) {
    return {
      recommend640: false,
      reasons: ['quality benchmark result is unavailable'],
      recoveredMisses: null,
    }
  }
  const result320 = modelResults.find(
    (entry) => entry.modelId === 'yolov9m-320' && entry.preprocessMode === 'letterbox',
  )
  const result640 = modelResults.find(
    (entry) => entry.modelId === 'yolov9m-640' && entry.preprocessMode === 'letterbox',
  )
  if (!result320 || !result640) {
    return {
      recommend640: false,
      reasons: ['production-equivalent CamStack 320/640 result is incomplete'],
      recoveredMisses: null,
    }
  }
  const missIds = new Set(
    manifest.items.filter((item) => item.role === 'miss').map((item) => item.id),
  )
  const controlId = manifest.items.find((item) => item.role === 'control')?.id
  const recoveredMisses = result640.images.filter(
    (image) => missIds.has(image.itemId) && image.evaluation.atCurrent.recovered,
  ).length
  const control320 = result320.images.find((image) => image.itemId === controlId)
  const control640 = result640.images.find((image) => image.itemId === controlId)
  const controlRegressed =
    Boolean(control320?.evaluation.atCurrent.recovered) &&
    !control640?.evaluation.atCurrent.recovered
  const decision = assessResolutionDecision({
    recoveredMisses,
    totalMisses: missIds.size,
    controlRegressed,
    falsePositivesRegressed: null,
    realConcurrency: capacity?.realConcurrency ?? null,
    capacityNMax640: capacity?.capacityNMax640 ?? null,
  })
  return { ...decision, recoveredMisses }
}

function readJsonIfExists<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function safePackageName(path: string): string {
  return basename(path)
}

function describeDeclaredClasses(names: string | undefined): string {
  if (!names) return ''
  const classCount = names.match(/\d+:/g)?.length ?? 0
  return classCount > 10 ? `${classCount} classes (COCO metadata)` : names
}

export function pythonCommandForReport(pythonPath: string): string {
  const command = basename(pythonPath)
  return /^python(?:\d+(?:\.\d+)*)?$/.test(command) ? command : '$PYTHON_COREML'
}

function writeAggregateReport(
  manifest: CorpusManifest,
  pythonPath: string,
  capacityPath?: string,
): void {
  const inspection = readJsonIfExists<readonly ArtifactInspection[]>(
    join(RESULT_DIR, 'artifact-inspection.json'),
  )
  const transport = readJsonIfExists<readonly ReturnType<typeof summariseTransportSamples>[]>(
    join(RESULT_DIR, 'transport.json'),
  )
  const quality = readJsonIfExists<{
    readonly cases: readonly ModelBenchmarkResult[]
    readonly routes: readonly RouteBenchmarkResult[]
  }>(join(RESULT_DIR, 'quality.json'))
  const capacity = capacityPath
    ? readJsonIfExists<{ readonly realConcurrency: number; readonly capacityNMax640: number }>(
        resolve(capacityPath),
      )
    : null
  const decision = deriveDecision(manifest, quality?.cases ?? null, capacity)
  const environment = environmentSnapshot(pythonPath)
  const reportPython = pythonCommandForReport(pythonPath)

  const lines: string[] = [
    '# Pipeline frame detector evaluation (Task 1)',
    '',
    'Generated deterministically from the private benchmark result set.',
    '',
    '## Scope and safety',
    '',
    '- Private images, model cache, overlays and raw JSON results live under `scratchpad/model-eval/` and are gitignored.',
    '- This report contains aggregate values and corpus ids only; it contains no image bytes, tokens or private cache paths.',
    '- No runtime, capability, model default or production setting was changed.',
    '',
    '## Reproduction',
    '',
    '```sh',
    'npx tsx scripts/pipeline-frame-model-eval.ts prepare',
    'npx tsx scripts/pipeline-frame-model-eval.ts dry-run',
    'npx tsx scripts/pipeline-frame-model-eval.ts fetch',
    `npx tsx scripts/pipeline-frame-model-eval.ts inspect --python ${reportPython}`,
    'npx tsx scripts/pipeline-frame-model-eval.ts transport --iterations 10',
    `npx tsx scripts/pipeline-frame-model-eval.ts benchmark --python ${reportPython} --warmup 3 --iterations 10`,
    `npx tsx scripts/pipeline-frame-model-eval.ts report --python ${reportPython}`,
    '```',
    '',
    '## Environment',
    '',
    `- macOS ${environment.macos ?? 'unknown'}; ${environment.architecture}.`,
    `- Hardware: ${environment.hardware ?? 'unknown'}.`,
    `- Node: ${environment.node}; Python: ${environment.python ?? 'unavailable'}; CoreMLTools: ${environment.coremltools ?? 'unavailable'}.`,
    `- Compute units: ${environment.coremlComputeUnits}.`,
    '',
    '## Corpus and ground truth',
    '',
    `- ${manifest.items.length} approved images: ${manifest.items.filter((item) => item.role === 'miss').length} misses and ${manifest.items.filter((item) => item.role === 'control').length} positive control.`,
    `- Targets: ${manifest.items.map((item) => `${item.id}=${item.label}`).join(', ')}.`,
    '- Exact originating bboxes were unavailable. The private manifest therefore records explicit target-region descriptions, not invented coordinates. Recovery is class-presence at threshold; IoU and false-positive counts are unassessed.',
    `- Candidate floor ${CANDIDATE_THRESHOLD.toFixed(2)}; comparison threshold ${COMPARISON_THRESHOLD.toFixed(2)}; current animal threshold ${CURRENT_ANIMAL_THRESHOLD.toFixed(2)}; NMS IoU ${NMS_IOU_THRESHOLD.toFixed(2)}.`,
    '',
    '## Artifact inspection',
    '',
  ]

  if (!inspection) {
    lines.push('- Not measured: run `fetch` then `inspect`.')
  } else {
    for (const artifact of inspection) {
      const spec = artifact.coremlSpec
      const weight = artifact.files.find((file) => file.path.endsWith('/weight.bin'))
      const declaredClasses = describeDeclaredClasses(spec?.metadata.names)
      lines.push(
        `- ${artifact.modelId}: [Hugging Face tree](https://huggingface.co/${artifact.repo}/tree/main/${artifact.treePath}); ${safePackageName(artifact.packagePath)}, ${(artifact.bytes / 1024 / 1024).toFixed(2)} MiB; weight sha256 ${weight?.sha256 ?? 'unavailable'}; inputs ${spec?.inputs.map((input) => `${input.name}:${input.type}[${input.shape?.join('×') ?? ''}]`).join(', ') ?? 'CoreML spec unavailable'}; outputs ${spec?.outputs.map((output) => `${output.name}:${output.type}[${output.shape?.join('×') ?? ''}]`).join(', ') ?? 'unavailable'}${declaredClasses ? `; declared classes ${declaredClasses}` : ''}.`,
      )
    }
  }

  lines.push('', '## Quality and geometry', '')
  if (!quality) {
    lines.push('- Not measured: CoreML benchmark result is unavailable.')
  } else {
    for (const benchmarkCase of quality.cases) {
      const imageSummary = benchmarkCase.images
        .map((image) => {
          const current = image.evaluation.atCurrent
          const at020 = image.evaluation.at020
          return `${image.itemId}: target=${image.targetLabel}, candidates=${image.evaluation.candidates.length}, recovered@0.20=${at020.recovered}, best@0.20=${at020.bestScore?.toFixed(3) ?? 'none'}, recovered@current=${current.recovered}, best@current=${current.bestScore?.toFixed(3) ?? 'none'}, median/p95=${image.latencyMs.median}/${image.latencyMs.p95}ms`
        })
        .join('; ')
      lines.push(
        `- ${benchmarkCase.modelId} / ${benchmarkCase.preprocessMode} (${benchmarkCase.scenarios.join('+')}): ${imageSummary}.`,
      )
    }
    lines.push(
      `- Annotated overlays were generated privately for every model/preprocess/image combination (${quality.cases.length * manifest.items.length} files).`,
    )
  }

  lines.push('', '## Raw/JPEG cost on content-sized frames', '')
  if (!transport) {
    lines.push('- Preparation cost not measured: run `transport`.')
  } else {
    for (const entry of transport) {
      lines.push(
        `- ${entry.width}×${entry.height}: raw ${formatBytes(entry.rawBytes)}; JPEG median/p95 ${formatBytes(entry.jpegBytesMedian)}/${formatBytes(entry.jpegBytesP95)}; raw materialization median/p95 ${entry.rawMaterializeMsMedian}/${entry.rawMaterializeMsP95}ms; JPEG encode median/p95 ${entry.jpegEncodeMsMedian}/${entry.jpegEncodeMsP95}ms.`,
      )
    }
  }
  if (quality) {
    for (const route of quality.routes) {
      lines.push(
        `- Pool e2e ${route.modelId} ${route.width}×${route.height} ${route.format}: payload median/p95 ${formatBytes(route.payloadBytesMedian)}/${formatBytes(route.payloadBytesP95)}, median/p95 ${route.e2eMsMedian}/${route.e2eMsP95}ms after warmup.`,
      )
    }
  }

  lines.push(
    '',
    '## Capacity runner reproduction',
    '',
    '- The existing production-path runner is reused without modification through Benchmark → Capacity: upload a positive content frame, resolve an explicit root model, set `targetSize: 106`, `fpsPerCamera: 10`, `settleSec: 30`, `measureSec: 120`, `warmupCalls: 3`, and ramp `2,4,8,12,16,20,24,28,32`.',
    '- Before a real run, pause the measured node with `node scripts/capacity/pause-restore.mjs pause --scope node:<nodeId> --apply`; after it, always run `restore --apply` and `verify`. The UI performs `cacheBenchFrame`, fire-and-poll `runCapacityRamp` / `getCapacityRampStatus`, and frame release.',
    '- CoreML capacity is runnable where the reachable `pipeline-runner` is local. OpenVINO NPU/iGPU on a remote agent is currently blocked: `addons.custom` resolves against the hub registry and refuses proxying custom actions to remote agents, while the runner also rejects a foreign `nodeId` (`packages/addon-benchmark/src/capacity-payloads.ts`). Supplying `nodeId` would not make a remote measurement.',
    '- The result must provide `realConcurrency` and `capacityNMax640`; 640 needs `capacityNMax640 >= ceil(realConcurrency × 1.25)`.',
    capacity
      ? `- Imported capacity evidence: real concurrency ${capacity.realConcurrency}, 640 N_max ${capacity.capacityNMax640}.`
      : '- No capacity result was supplied to this local run; no production node was mutated.',
    '',
    '## Decision',
    '',
    `- Recommend 640 now: ${decision.recommend640 ? 'YES' : 'NO'}.`,
    `- Recovered misses at current threshold: ${decision.recoveredMisses ?? 'unavailable'}/3.`,
    ...decision.reasons.map((reason) => `- Gate not met: ${reason}.`),
    '- The runtime default remains unchanged; promotion belongs to the rollout task.',
    '',
    '## Limits',
    '',
    '- Annotation-only ground truth supports target recovery but not defensible IoU or false-positive regression counts.',
    '- The declared positive control was not recovered at the current 0.50 threshold by either CamStack resolution; plugin catalog recovered it only with common letterbox at 0.20. The control therefore does not validate a 640 promotion in this run.',
    '- CoreML `ComputeUnit.ALL` allows ANE execution but public CoreML APIs do not prove per-operation ANE placement; timings are wall-clock measurements on this Mac.',
    '- The four-image corpus is diagnostic, not a statistically representative accuracy dataset.',
    '- Capacity on live OpenVINO NPU/iGPU and real CoreML concurrency requires the existing quiet-node runner and was not inferred from single-image latency.',
    '',
  )
  writeTextAtomic(VERSIONED_REPORT, lines.join('\n'), 0o644)
}

/**
 * One named case (`miss-dog-101`) rendered as a frame × configuration table
 * and spliced into the versioned report between two markers, so the historical
 * corpus decision above it is left untouched on a machine that only has the
 * new case's images.
 */
export function renderCaseSection(
  caseId: string,
  manifest: CorpusManifest,
  results: readonly ModelBenchmarkResult[],
  environment: { readonly hardware: string | null; readonly recordedAt: string },
): string {
  const items = manifest.items.filter((item) => item.caseId === caseId)
  const lines: string[] = [
    `<!-- case:${caseId}:start -->`,
    `## Case \`${caseId}\` — is the animal under threshold, or absent?`,
    '',
    `Recorded ${environment.recordedAt} on ${environment.hardware ?? 'unknown hardware'} (CoreML). Frames: ${items.map((item) => `\`${item.id}\``).join(', ')}.`,
    '',
    '- Each frame is a 3840×2160 key frame of camera 101 with a dog in the scene and no `animal` emitted live. The dog box is hand-read at 1/3 scale (±30 px); "overlap" is IoU ≥ 0.30 with that box.',
    `- \`native-region\` cuts a full-resolution square of at least ${NATIVE_REGION_MIN_SIDE_PX} px around the moving region (padding ${NATIVE_REGION_PADDING_RATIO}) and runs the production 320 letterbox model on it — the second pass of the runner.`,
    '- "animals@0.10" lists every animal-class box (COCO animal classes) scoring ≥ 0.10 anywhere in the frame; the overlap column says whether one of them is the dog.',
    '',
    '| frame | configuration | animals@0.10 (class:score) | overlaps dog box | best overlapping | median ms |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of items) {
    for (const result of results) {
      const image = result.images.find((entry) => entry.itemId === item.id)
      if (!image) continue
      const configuration = `${result.modelId} / ${result.preprocessMode} / ${result.source === 'native-region' ? `native-region ${image.nativeCrop?.width ?? '?'}px` : 'full frame'}`
      const animals = image.animalRecovery.animalsAtLow
        .map((detection) => `${detection.class}:${detection.score.toFixed(2)}`)
        .join(', ')
      const overlap =
        image.animalRecovery.bestOverlappingScore === null
          ? 'no'
          : `yes (${image.animalRecovery.bestOverlappingClass} ${image.animalRecovery.bestOverlappingScore.toFixed(2)})`
      lines.push(
        `| ${item.id} | ${configuration} | ${animals || '—'} | ${overlap} | ${image.animalRecovery.bestOverlappingScore?.toFixed(2) ?? '—'} | ${image.latencyMs.median} |`,
      )
    }
  }
  lines.push('', `<!-- case:${caseId}:end -->`)
  return lines.join('\n')
}

/** Replace (or append) the marked section of `caseId` in `report`. */
export function spliceCaseSection(report: string, caseId: string, section: string): string {
  const start = `<!-- case:${caseId}:start -->`
  const end = `<!-- case:${caseId}:end -->`
  const from = report.indexOf(start)
  const to = report.indexOf(end)
  if (from >= 0 && to > from) {
    return `${report.slice(0, from)}${section}${report.slice(to + end.length)}`
  }
  return `${report.trimEnd()}\n\n${section}\n`
}

interface CliOptions {
  readonly command: string
  readonly pythonPath: string
  readonly warmup: number
  readonly iterations: number
  readonly capacityPath?: string
  readonly caseId?: string
}

function readOption(args: readonly string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

function parseCli(args: readonly string[]): CliOptions {
  const command = args[0] ?? 'dry-run'
  const pythonPath = readOption(args, 'python', DEFAULT_PYTHON) as string
  const warmup = Number(readOption(args, 'warmup', '3'))
  const iterations = Number(readOption(args, 'iterations', '10'))
  if (!Number.isInteger(warmup) || warmup < 0)
    throw new Error('--warmup must be a non-negative integer')
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('--iterations must be a positive integer')
  }
  return {
    command,
    pythonPath,
    warmup,
    iterations,
    capacityPath: readOption(args, 'capacity-file'),
    caseId: readOption(args, 'case'),
  }
}

function writeCaseReport(manifest: CorpusManifest, pythonPath: string, caseId: string): void {
  const quality = readJsonIfExists<{ readonly cases: readonly ModelBenchmarkResult[] }>(
    join(RESULT_DIR, 'quality.json'),
  )
  if (!quality) throw new Error('quality benchmark result is unavailable: run benchmark first')
  const environment = environmentSnapshot(pythonPath)
  const section = renderCaseSection(caseId, manifest, quality.cases, environment)
  const current = existsSync(VERSIONED_REPORT) ? readFileSync(VERSIONED_REPORT, 'utf8') : ''
  writeTextAtomic(VERSIONED_REPORT, spliceCaseSection(current, caseId, section), 0o644)
}

function dryRun(manifest: CorpusManifest, pythonPath: string): void {
  const plan = {
    corpus: manifest.items.map((item) => ({
      id: item.id,
      role: item.role,
      label: item.label,
      groundTruth: item.bbox ? 'bbox' : 'annotation-only',
    })),
    cases: buildBenchmarkCases(),
    thresholds: {
      candidates: CANDIDATE_THRESHOLD,
      comparison: COMPARISON_THRESHOLD,
      currentAnimal: CURRENT_ANIMAL_THRESHOLD,
      nmsIou: NMS_IOU_THRESHOLD,
    },
    transportSizes: [
      { width: 320, height: 180, rawBytes: 320 * 180 * 3 },
      { width: 640, height: 360, rawBytes: 640 * 360 * 3 },
    ],
    python: pythonPath,
    coremlAvailable:
      spawnSync(pythonPath, ['-c', 'import coremltools, PIL, numpy'], { timeout: 30_000 })
        .status === 0,
    mutatesProduction: false,
    writesOnly: ['scratchpad/model-eval/**', relative(REPO, VERSIONED_REPORT).split(sep).join('/')],
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  let manifest: CorpusManifest
  if (options.command === 'prepare' || options.command === 'all') {
    manifest = prepareCorpus()
  } else {
    manifest = readManifest()
  }

  if (options.command === 'prepare') {
    process.stdout.write(`prepared ${manifest.items.length} private corpus items in ${SCRATCH}\n`)
    return
  }
  if (options.command === 'dry-run') {
    dryRun(manifest, options.pythonPath)
    return
  }
  if (options.command === 'fetch' || options.command === 'all') {
    await fetchArtifacts()
    process.stdout.write(`cached ${ARTIFACTS.length} CoreML packages under ${CACHE_DIR}\n`)
  }
  if (options.command === 'inspect' || options.command === 'all') {
    const inspection = inspectArtifacts(options.pythonPath)
    writeJsonAtomic(join(RESULT_DIR, 'artifact-inspection.json'), inspection)
    process.stdout.write(`inspected ${inspection.length} CoreML packages\n`)
  }
  if (options.command === 'transport' || options.command === 'all') {
    const transport = await measureTransport(manifest, options.iterations)
    writeJsonAtomic(join(RESULT_DIR, 'transport.json'), transport)
    process.stdout.write(`measured raw/JPEG preparation at ${transport.length} content sizes\n`)
  }
  if (options.command === 'benchmark' || options.command === 'all') {
    if (!ARTIFACTS.every((artifact) => existsSync(artifactPackagePath(artifact)))) {
      throw new Error('model cache is incomplete: run fetch first')
    }
    const quality = await runModelBenchmark(
      manifest,
      options.pythonPath,
      options.warmup,
      options.iterations,
    )
    writeJsonAtomic(join(RESULT_DIR, 'quality.json'), quality)
    process.stdout.write(`benchmarked ${quality.cases.length} model/preprocess cases\n`)
  }
  if (options.command === 'report' || options.command === 'all') {
    writeAggregateReport(manifest, options.pythonPath, options.capacityPath)
    process.stdout.write(`wrote aggregate report ${VERSIONED_REPORT}\n`)
  }
  if (options.command === 'report-case') {
    const caseId = options.caseId ?? MISS_DOG_101_CASE_ID
    writeCaseReport(manifest, options.pythonPath, caseId)
    process.stdout.write(`wrote case section ${caseId} into ${VERSIONED_REPORT}\n`)
  }

  if (
    !['fetch', 'inspect', 'transport', 'benchmark', 'report', 'report-case', 'all'].includes(
      options.command,
    )
  ) {
    throw new Error(
      'usage: pipeline-frame-model-eval.ts prepare|dry-run|fetch|inspect|transport|benchmark|report|report-case|all',
    )
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
