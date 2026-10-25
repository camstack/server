import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  animalDetectionsAtThreshold,
  assessResolutionDecision,
  buildBenchmarkCases,
  buildNativeRegionCase,
  CORPUS_SOURCES,
  type CorpusManifest,
  type Detection,
  deriveDecision,
  evaluateImageDetections,
  MISS_DOG_101_CASE_ID,
  NATIVE_REGION_MIN_SIDE_PX,
  offsetCropDetections,
  percentile,
  planNativeRegionCrop,
  projectResizeDetections,
  pythonCommandForReport,
  resolveArtifactSpec,
  resolveTargetLabel,
  summariseTransportSamples,
  validateCorpusManifest,
  validateHfRelativePath,
  writeTextAtomic,
} from '../pipeline-frame-model-eval.ts'

describe('miss-dog-101 native-region case', () => {
  it('ships the three camera-101 dog key frames as one benchmark case with a native region', () => {
    const dogs = CORPUS_SOURCES.filter((item) => item.caseId === MISS_DOG_101_CASE_ID)
    expect(dogs).toHaveLength(3)
    for (const item of dogs) {
      expect(item.role).toBe('miss')
      expect(item.label).toBe('dog')
      expect(item.bbox).toBeDefined()
      expect(item.nativeCropRegion).toBeDefined()
    }
    // The original four-image corpus is still there, next to the new case.
    expect(CORPUS_SOURCES.some((item) => item.id === 'control-plugin-catalog-cat')).toBe(true)
  })

  it('accepts a corpus without a positive control (the case is a set of misses)', () => {
    const manifest: CorpusManifest = {
      version: 1,
      items: [
        {
          id: 'miss-dog-101-a',
          filename: 'a.jpg',
          role: 'miss',
          label: 'dog',
          currentThreshold: 0.5,
          bbox: [10, 10, 40, 40],
        },
      ],
    }
    expect(() => validateCorpusManifest(manifest)).not.toThrow()
    expect(() => validateCorpusManifest({ version: 1, items: [] })).toThrow(
      'corpus requires at least one miss',
    )
  })

  it('plans a square native crop no smaller than the second-pass floor, clamped to the frame', () => {
    // A small region near the top-right corner of a 4K frame: the square is
    // grown to the floor and shifted back inside the frame, never clamped to a
    // rectangle (the model input is square; a clamp would change the scale).
    const crop = planNativeRegionCrop([0.9, 0.05, 0.98, 0.12], 3840, 2160)
    expect(crop.width).toBe(crop.height)
    expect(crop.width).toBeGreaterThanOrEqual(NATIVE_REGION_MIN_SIDE_PX)
    expect(crop.left).toBeGreaterThanOrEqual(0)
    expect(crop.top).toBeGreaterThanOrEqual(0)
    expect(crop.left + crop.width).toBeLessThanOrEqual(3840)
    expect(crop.top + crop.height).toBeLessThanOrEqual(2160)
    // The region itself is inside the crop.
    expect(crop.left).toBeLessThanOrEqual(0.9 * 3840)
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(0.98 * 3840)

    // A large region keeps its own (padded) size instead of the floor.
    const wide = planNativeRegionCrop([0.2, 0.1, 0.7, 0.6], 3840, 2160)
    expect(wide.width).toBeGreaterThan(NATIVE_REGION_MIN_SIDE_PX)
    expect(wide.width).toBe(wide.height)
  })

  it('maps crop-space boxes back into frame space by the crop offset only', () => {
    const mapped = offsetCropDetections([{ class: 'dog', score: 0.7, bbox: [10, 20, 110, 220] }], {
      left: 1000,
      top: 500,
      width: 640,
      height: 640,
    })
    expect(mapped).toEqual([{ class: 'dog', score: 0.7, bbox: [1010, 520, 1110, 720] }])
  })

  it('lists animal-class boxes above a threshold, best first', () => {
    const animals = animalDetectionsAtThreshold(
      [
        { class: 'person', score: 0.9, bbox: [0, 0, 1, 1] },
        { class: 'dog', score: 0.12, bbox: [0, 0, 1, 1] },
        { class: 'cat', score: 0.4, bbox: [0, 0, 1, 1] },
        { class: 'dog', score: 0.05, bbox: [0, 0, 1, 1] },
      ],
      0.1,
    )
    expect(animals.map((d) => `${d.class}:${d.score}`)).toEqual(['cat:0.4', 'dog:0.12'])
  })

  it('runs the native-region pass on the production 320 letterbox model', () => {
    const nativeCase = buildNativeRegionCase()
    expect(nativeCase.modelId).toBe('yolov9m-320')
    expect(nativeCase.preprocessMode).toBe('letterbox')
    expect(nativeCase.source).toBe('native-region')
    // The pool model index it borrows is the production-equivalent 320 case.
    expect(buildBenchmarkCases()[nativeCase.poolModelIndex]?.modelId).toBe('yolov9m-320')
    expect(buildBenchmarkCases()[nativeCase.poolModelIndex]?.preprocessMode).toBe('letterbox')
  })
})

describe('pipeline frame model evaluation pure helpers', () => {
  it('uses nearest-rank median and p95 without mutating measurements', () => {
    const samples = [9, 1, 5, 3]

    expect(percentile(samples, 0.5)).toBe(3)
    expect(percentile(samples, 0.95)).toBe(9)
    expect(samples).toEqual([9, 1, 5, 3])
  })

  it('builds production-equivalent and common-preprocess cases without duplicates', () => {
    const cases = buildBenchmarkCases()

    expect(cases).toHaveLength(6)
    expect(cases.map((entry) => `${entry.modelId}:${entry.preprocessMode}`)).toEqual([
      'scrypted-yolov9c-relu-test:resize',
      'scrypted-yolov9c-relu-test:letterbox',
      'yolov9m-320:letterbox',
      'yolov9m-320:resize',
      'yolov9m-640:letterbox',
      'yolov9m-640:resize',
    ])
    expect(cases[0]?.scenarios).toEqual(['production-equivalent', 'common-resize'])
    expect(cases[1]?.scenarios).toEqual(['common-letterbox'])
  })

  it('maps plugin catalog macro classes while leaving CamStack COCO targets unchanged', () => {
    expect(resolveTargetLabel('scrypted-yolov9c-relu-test', 'cat')).toBe('animal')
    expect(resolveTargetLabel('scrypted-yolov9c-relu-test', 'bird')).toBe('animal')
    expect(resolveTargetLabel('yolov9m-320', 'cat')).toBe('cat')
    expect(resolveTargetLabel('yolov9m-640', 'bird')).toBe('bird')
  })

  it('projects square-resize model boxes back to original image coordinates', () => {
    const projected = projectResizeDetections(
      [{ class: 'cat', score: 0.8, bbox: [32, 18, 160, 90] }],
      320,
      640,
      360,
    )

    expect(projected).toEqual([{ class: 'cat', score: 0.8, bbox: [64, 20.25, 320, 101.25] }])
  })

  it('keeps 0.01 candidates and evaluates 0.20/current thresholds independently', () => {
    const detections: Detection[] = [
      { class: 'cat', score: 0.19, bbox: [10, 10, 30, 30] },
      { class: 'cat', score: 0.51, bbox: [11, 11, 29, 29] },
      { class: 'dog', score: 0.8, bbox: [70, 70, 90, 90] },
      { class: 'bird', score: 0.009, bbox: [1, 1, 2, 2] },
    ]

    const result = evaluateImageDetections(
      detections,
      { label: 'cat', bbox: [10, 10, 30, 30] },
      0.5,
    )

    expect(result.candidates).toHaveLength(3)
    expect(result.at020.recovered).toBe(true)
    expect(result.atCurrent.recovered).toBe(true)
    expect(result.atCurrent.bestIou).toBeCloseTo(0.81)
    expect(result.atCurrent.falsePositives).toBe(1)
  })

  it('reports unavailable IoU and false positives for an annotation-only target', () => {
    const result = evaluateImageDetections(
      [{ class: 'cat', score: 0.6, bbox: [1, 1, 2, 2] }],
      { label: 'cat', annotation: 'black cat in the upper-right pavement region' },
      0.5,
    )

    expect(result.atCurrent.recovered).toBe(true)
    expect(result.atCurrent.bestIou).toBeNull()
    expect(result.atCurrent.falsePositives).toBeNull()
  })

  it('does not recover a target whose best IoU is below 0.5', () => {
    const result = evaluateImageDetections(
      [{ class: 'cat', score: 0.8, bbox: [0, 0, 4, 10] }],
      { label: 'cat', bbox: [0, 0, 10, 10] },
      0.5,
    )

    expect(result.atCurrent.recovered).toBe(false)
    expect(result.atCurrent.bestIou).toBeCloseTo(0.4)
    expect(result.atCurrent.falsePositives).toBe(1)
  })

  it('rejects manifest items that have neither a bbox nor an explicit annotation', () => {
    const manifest = {
      version: 1,
      items: [
        {
          id: 'miss-1',
          filename: 'miss-1.jpg',
          role: 'miss',
          label: 'cat',
          currentThreshold: 0.5,
        },
      ],
    } as CorpusManifest

    expect(() => validateCorpusManifest(manifest)).toThrow(
      'miss-1 requires bbox or explicit annotation',
    )
  })

  it('requires two recovered misses, no regression, and 25% capacity headroom', () => {
    expect(
      assessResolutionDecision({
        recoveredMisses: 2,
        totalMisses: 3,
        controlRegressed: false,
        falsePositivesRegressed: false,
        realConcurrency: 8,
        capacityNMax640: 10,
      }),
    ).toEqual({ recommend640: true, reasons: [] })

    const failed = assessResolutionDecision({
      recoveredMisses: 1,
      totalMisses: 3,
      controlRegressed: true,
      falsePositivesRegressed: false,
      realConcurrency: 8,
      capacityNMax640: 9,
    })
    expect(failed.recommend640).toBe(false)
    expect(failed.reasons).toEqual([
      '640 recovered 1/3 misses; at least 2 are required',
      '640 regressed on the positive control',
      '640 capacity 9 is below the required 10 for 25% headroom over concurrency 8',
    ])
  })

  it('makes false-positive evidence and capacity availability explicit decision gates', () => {
    expect(
      assessResolutionDecision({
        recoveredMisses: 2,
        totalMisses: 3,
        controlRegressed: false,
        falsePositivesRegressed: true,
        realConcurrency: 8,
        capacityNMax640: 10,
      }),
    ).toEqual({ recommend640: false, reasons: ['640 regressed on false positives'] })

    expect(
      assessResolutionDecision({
        recoveredMisses: 2,
        totalMisses: 3,
        controlRegressed: false,
        falsePositivesRegressed: null,
        realConcurrency: null,
        capacityNMax640: null,
      }),
    ).toEqual({
      recommend640: false,
      reasons: [
        'false-positive regression is unassessed because exact ground-truth boxes are unavailable',
        'real concurrency or 640 capacity result is unavailable',
      ],
    })
  })

  it('uses assessResolutionDecision as the only promotion gate', () => {
    const manifest: CorpusManifest = {
      version: 1,
      items: [
        {
          id: 'miss-1',
          filename: 'miss-1.jpg',
          role: 'miss',
          label: 'cat',
          currentThreshold: 0.5,
          annotation: 'target',
        },
        {
          id: 'miss-2',
          filename: 'miss-2.jpg',
          role: 'miss',
          label: 'cat',
          currentThreshold: 0.5,
          annotation: 'target',
        },
        {
          id: 'miss-3',
          filename: 'miss-3.jpg',
          role: 'miss',
          label: 'cat',
          currentThreshold: 0.5,
          annotation: 'target',
        },
        {
          id: 'control',
          filename: 'control.jpg',
          role: 'control',
          label: 'cat',
          currentThreshold: 0.5,
          annotation: 'target',
        },
      ],
    }
    const image = (itemId: string, recovered: boolean) => ({
      itemId,
      targetLabel: 'cat',
      latencyMs: { median: 1, p95: 1 },
      evaluation: evaluateImageDetections(
        recovered ? [{ class: 'cat', score: 0.8, bbox: [0, 0, 1, 1] }] : [],
        { label: 'cat', annotation: 'target' },
        0.5,
      ),
    })
    const modelResults: Parameters<typeof deriveDecision>[1] = [
      {
        modelId: 'yolov9m-320',
        preprocessMode: 'letterbox',
        scenarios: ['production-equivalent'],
        inputSize: 320,
        images: [image('control', false)],
      },
      {
        modelId: 'yolov9m-640',
        preprocessMode: 'letterbox',
        scenarios: ['production-equivalent'],
        inputSize: 640,
        images: [image('miss-1', true), image('miss-2', true), image('control', false)],
      },
    ]

    expect(
      deriveDecision(manifest, modelResults, { realConcurrency: 8, capacityNMax640: 10 }),
    ).toEqual({
      recommend640: false,
      recoveredMisses: 2,
      reasons: [
        'false-positive regression is unassessed because exact ground-truth boxes are unavailable',
      ],
    })
  })

  it('atomically replaces a report without leaving a temporary file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-eval-report-'))
    const report = join(directory, 'report.md')
    try {
      writeFileSync(report, 'old')

      writeTextAtomic(report, 'new\n')

      expect(readFileSync(report, 'utf8')).toBe('new\n')
      expect(readdirSync(directory)).toEqual(['report.md'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails clearly when a benchmark case has no artifact definition', () => {
    expect(() => resolveArtifactSpec('unknown-model')).toThrow(
      'benchmark model unknown-model has no artifact definition',
    )
  })

  it('rejects absolute and traversing Hugging Face paths', () => {
    expect(validateHfRelativePath('models/yolo/file.mlmodel', 'test path')).toBe(
      'models/yolo/file.mlmodel',
    )
    expect(() => validateHfRelativePath('/etc/passwd', 'test path')).toThrow(
      'test path must be a safe relative Hugging Face path',
    )
    expect(() => validateHfRelativePath('models/../secret', 'test path')).toThrow(
      'test path must be a safe relative Hugging Face path',
    )
  })

  it('uses a machine-neutral Python command in the versioned report', () => {
    expect(pythonCommandForReport('/opt/homebrew/opt/python@3.13/bin/python3.13')).toBe(
      'python3.13',
    )
    expect(pythonCommandForReport('/private/venv/bin/coreml-python')).toBe('$PYTHON_COREML')
  })

  it('summarises content-sized raw and JPEG samples with exact RGB payload bytes', () => {
    const summary = summariseTransportSamples(320, 180, [
      { jpegBytes: 10_000, rawMaterializeMs: 0.4, jpegEncodeMs: 2.1 },
      { jpegBytes: 12_000, rawMaterializeMs: 0.6, jpegEncodeMs: 2.9 },
    ])

    expect(summary.rawBytes).toBe(320 * 180 * 3)
    expect(summary.jpegBytesMedian).toBe(10_000)
    expect(summary.jpegBytesP95).toBe(12_000)
    expect(summary.rawMaterializeMsMedian).toBe(0.4)
    expect(summary.jpegEncodeMsP95).toBe(2.9)
  })
})
