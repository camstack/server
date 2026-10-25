/**
 * Plate min-size gate — the plate-OCR (`ctc`) leaf must be SKIPPED when the
 * ACTUAL crop that would feed the recognizer is too small to hold a readable
 * plate. The measurement is the LONG side (see `MIN_PLATE_OCR_LONG_SIDE_PX`):
 * a plate's information lives along its text run, and the old short-side floor
 * of 20px passed every 60×46 tile in the 2026-08 cam-102 audit — none of which
 * produced a correct read. The gate measures:
 *  - the NATIVE crop dimensions when the native ROI fetch succeeded (they ARE
 *    the plate's real native size), or
 *  - the fallback detection-space tile — which IS the input OCR would read.
 * A skip logs one debug line and never drops the parent detection.
 */
import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import type {
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  IScopedLogger,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { PipelineExecutor } from '../executor.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'
import type { NativeFaceCropProvider } from '../face-align.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAME_WIDTH = 200
const FRAME_HEIGHT = 200
const DEVICE_ID = 1

function makeModelEntry(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 64, height: 64 },
    labels: [],
  }
}

/** Root detector emitting `plate` detections directly (unit shortcut — in the
 *  real tree the plate parent comes from `plate-detection`; the gate only
 *  reads the parent bbox + the ctc postprocessor marker). */
const rootStepDefinition: StepDefinition = {
  id: 'test-plate-detection',
  name: 'Test Plate Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['plate'],
  models: [makeModelEntry('stub-root-model')],
  defaultModelId: 'stub-root-model',
  defaultConfidence: 0.5,
}

/** The plate-OCR leaf (`ctc` postprocessor) — mirrors the real `plate-ocr`. */
const ocrStepDefinition: StepDefinition = {
  id: 'test-plate-ocr',
  name: 'Test Plate OCR',
  slot: 'classifier',
  postprocessor: 'ctc',
  extractMode: 'crop-roi',
  inputClasses: ['plate'],
  outputClasses: ['plate-text'],
  models: [makeModelEntry('stub-ocr-model')],
  defaultModelId: 'stub-ocr-model',
  defaultConfidence: 0,
}

function makeStubEngine(output: EngineOutput): IInferenceEngine & {
  readonly infer: ReturnType<typeof vi.fn>
} {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => output),
    dispose: async () => {},
  }
}

async function makeFrameJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer()
}

interface DebugRecord {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
  readonly deviceId: unknown
}

function makeDebugLogger(records: DebugRecord[]): IScopedLogger {
  const record = (
    message: string,
    extras?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
  ): void => {
    records.push({ message, meta: extras?.meta, deviceId: extras?.tags?.['deviceId'] })
  }
  const logger: IScopedLogger = {
    debug: (message, extras) => record(message, extras),
    info: (message, extras) => record(message, extras),
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function buildTree(rootEngine: IInferenceEngine, ocrEngine: IInferenceEngine): ExecutableTree {
  const ocrStep: ExecutableStep = {
    stepId: ocrStepDefinition.id,
    definition: ocrStepDefinition,
    engine: ocrEngine,
    modelId: ocrStepDefinition.defaultModelId,
    inputClasses: ocrStepDefinition.inputClasses ?? [],
    enabled: true,
    children: [],
    // Deskew off: the gate is what's under test, not the rectifier.
    settings: { rectify: false },
  }
  const rootStep: ExecutableStep = {
    stepId: rootStepDefinition.id,
    definition: rootStepDefinition,
    engine: rootEngine,
    modelId: rootStepDefinition.defaultModelId,
    inputClasses: rootStepDefinition.inputClasses ?? [],
    enabled: true,
    children: [ocrStep],
  }
  return { roots: [rootStep] }
}

function makeRootEngine(
  plateBbox: readonly [number, number, number, number],
): ReturnType<typeof makeStubEngine> {
  return makeStubEngine({
    inferenceMs: 1,
    structured: {
      kind: 'detections',
      detections: [{ class: 'plate', score: 0.9, bbox: [...plateBbox] }],
    },
  })
}

function makeOcrEngine(): ReturnType<typeof makeStubEngine> {
  return makeStubEngine({
    inferenceMs: 1,
    structured: { kind: 'text', text: 'AB123CD', confidence: 0.95 },
  })
}

async function runTree(
  plateBbox: readonly [number, number, number, number],
  nativeCropProvider?: NativeFaceCropProvider,
): Promise<{
  rootEngine: ReturnType<typeof makeStubEngine>
  ocrEngine: ReturnType<typeof makeStubEngine>
  debugRecords: DebugRecord[]
  detections: number
}> {
  const rootEngine = makeRootEngine(plateBbox)
  const ocrEngine = makeOcrEngine()
  const tree = buildTree(rootEngine, ocrEngine)
  const debugRecords: DebugRecord[] = []
  const executor = new PipelineExecutor({
    engineRuntime: 'onnx+cpu',
    logger: makeDebugLogger(debugRecords),
  })
  const { result } = await executor.run(
    tree,
    { kind: 'jpeg', data: await makeFrameJpeg() },
    makeFrameJpeg,
    FRAME_WIDTH,
    FRAME_HEIGHT,
    DEVICE_ID,
    undefined,
    nativeCropProvider,
  )
  return { rootEngine, ocrEngine, debugRecords, detections: result.detections.length }
}

function skipLogs(records: readonly DebugRecord[]): DebugRecord[] {
  return records.filter((r) => r.message === 'plate ROI too small for OCR — skipping')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineExecutor — plate-OCR min-size gate', () => {
  it('skips OCR on a tiny detection-space plate tile (no native provider) and logs it', async () => {
    // bbox [10,10,25,22] → 15×12 tile; long side 15 < 85.
    const { ocrEngine, debugRecords, detections } = await runTree([10, 10, 25, 22])

    expect(ocrEngine.infer).not.toHaveBeenCalled()
    // The parent plate detection is NOT dropped by the gate.
    expect(detections).toBe(1)
    const skips = skipLogs(debugRecords)
    expect(skips).toHaveLength(1)
    expect(skips[0]?.deviceId).toBe(DEVICE_ID)
    expect(skips[0]?.meta).toMatchObject({
      step: 'test-plate-ocr',
      plateLongSidePx: 15,
      minPlateLongSidePx: 85,
      source: 'detection-tile',
    })
  })

  /**
   * THE live regression. Every cam-102 plate tile in the 2026-08 audit cleared
   * the old 20px SHORT-side floor (46 > 20) and none of them produced a correct
   * read — the long side is what carries the text run, and at 60px there is not
   * enough of it. The old gate let ~200 hopeless OCR calls through in 3 days.
   */
  it('skips a 60×46 tile — the short side clears 20px, the LONG side does not', async () => {
    // bbox [10,10,70,56] → 60×46 tile: short side 46 ≥ 20, long side 60 < 85.
    const { ocrEngine, debugRecords } = await runTree([10, 10, 70, 56])

    expect(ocrEngine.infer).not.toHaveBeenCalled()
    const skips = skipLogs(debugRecords)
    expect(skips).toHaveLength(1)
    expect(skips[0]?.meta).toMatchObject({ plateLongSidePx: 60, source: 'detection-tile' })
  })

  it('runs OCR when the tile long side is at/above the floor', async () => {
    // bbox [10,10,160,60] → 150×50 tile; long side 150 ≥ 85.
    const { ocrEngine, debugRecords } = await runTree([10, 10, 160, 60])

    expect(ocrEngine.infer).toHaveBeenCalledTimes(1)
    expect(skipLogs(debugRecords)).toHaveLength(0)
  })

  /**
   * The floor moved 100 → 85 when the quad warp landed (2026-08-20). On the
   * ground-truthed cam-102 set the four plates read EXACTLY after the warp
   * measure 91, 94, 95 and 98px native — every one of them was skipped by the
   * old 100px floor, and 85 is the largest floor that admits all four while
   * still producing zero grammar-valid reads on the 18 junk ROIs of the set.
   */
  it('runs OCR on a 90×45 tile — above the new floor, below the old one', async () => {
    // bbox [10,10,100,55] → 90×45 tile; 85 ≤ 90 < 100.
    const { ocrEngine, debugRecords } = await runTree([10, 10, 100, 55])

    expect(ocrEngine.infer).toHaveBeenCalledTimes(1)
    expect(skipLogs(debugRecords)).toHaveLength(0)
  })

  it('a NATIVE crop above the floor rescues a small detection-space plate (gate measures native)', async () => {
    // Detection tile would be 15×12 (skipped above) — but the native fetch
    // resolves the SAME ROI at 150×60 real pixels, so OCR must run.
    const provider: NativeFaceCropProvider = async () => ({
      bytes: new Uint8Array(150 * 60 * 3),
      width: 150,
      height: 60,
    })
    const { ocrEngine, debugRecords } = await runTree([10, 10, 25, 22], provider)

    expect(ocrEngine.infer).toHaveBeenCalledTimes(1)
    expect(skipLogs(debugRecords)).toHaveLength(0)
  })

  it('skips OCR when even the NATIVE crop is under the floor', async () => {
    // Native resolves, but the plate is genuinely tiny: 30×10 native px.
    const provider: NativeFaceCropProvider = async () => ({
      bytes: new Uint8Array(30 * 10 * 3),
      width: 30,
      height: 10,
    })
    const { ocrEngine, debugRecords, detections } = await runTree([10, 10, 40, 24], provider)

    expect(ocrEngine.infer).not.toHaveBeenCalled()
    expect(detections).toBe(1)
    const skips = skipLogs(debugRecords)
    expect(skips).toHaveLength(1)
    expect(skips[0]?.meta).toMatchObject({
      plateLongSidePx: 30,
      source: 'native',
    })
  })

  it('logs the OCR READ itself, tagged with the camera', async () => {
    // Intra-track concordance ("did the 5 reads agree?") is the cheap measure of
    // whether a camera's plate pixels are good enough. It is unmeasurable if the
    // reads never reach the log.
    const { debugRecords } = await runTree([10, 10, 160, 60])
    const reads = debugRecords.filter((r) => r.message === 'plate OCR read')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.deviceId).toBe(DEVICE_ID)
    expect(reads[0]?.meta).toMatchObject({ text: 'AB123CD', step: 'test-plate-ocr' })
  })
})
