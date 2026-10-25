import { describe, it, expect } from 'vitest'
import type {
  ICamstackAddon,
  AddonDeclaration,
  AddonContext,
  PipelineEngineChoice,
  FrameInput,
  CropInput,
  DetectorOutput,
  CropperOutput,
  ClassifierOutput,
} from '@camstack/types'
import { AddonLoader } from '../src/kernel/addon-loader'
import { AddonEngineManager } from '../src/kernel/addon-engine-manager'
import { PipelineRunner } from '../src/pipeline/pipeline-runner'
import { EngineManagerResolver } from '../src/pipeline/engine-manager-resolver'

// --- Mock Frame ---
const mockFrame: FrameInput = {
  data: Buffer.from([]),
  format: 'jpeg',
  width: 640,
  height: 480,
  timestamp: 1000,
}

// --- Mock detector ---
class MockDetectorAddon implements ICamstackAddon {
  readonly id = 'mock-detector'
  readonly manifest: AddonDeclaration = {
    id: 'mock-detector',
    name: 'Mock Detector',
    version: '0.1.0',
    description: '',
    slot: 'detector',
  }
  postBrokerStart(): void {}
  async initialize(_ctx: AddonContext): Promise<void> {}
  async shutdown(): Promise<void> {}

  async process(_frame: FrameInput): Promise<DetectorOutput> {
    return {
      detections: [
        {
          class: 'person',
          originalClass: 'person',
          score: 0.95,
          bbox: { x: 10, y: 10, w: 100, h: 200 },
        },
        { class: 'car', originalClass: 'car', score: 0.8, bbox: { x: 200, y: 50, w: 120, h: 80 } },
      ],
      inferenceMs: 20,
      modelId: 'yolov8n',
    }
  }
}

// --- Mock cropper ---
class MockCropperAddon implements ICamstackAddon {
  readonly id = 'mock-cropper'
  readonly manifest: AddonDeclaration = {
    id: 'mock-cropper',
    name: 'Mock Cropper',
    version: '0.1.0',
    description: '',
    slot: 'cropper',
  }
  postBrokerStart(): void {}
  async initialize(_ctx: AddonContext): Promise<void> {}
  async shutdown(): Promise<void> {}

  async process(input: FrameInput | CropInput): Promise<CropperOutput> {
    const cropInput = input as unknown as CropInput
    return {
      crops: [
        {
          class: cropInput.parentDetection.class,
          originalClass: cropInput.parentDetection.class,
          score: 0.99,
          bbox: cropInput.roi,
        },
      ],
      inferenceMs: 5,
      modelId: 'face-detector',
    }
  }
}

// --- Mock classifier ---
class MockClassifierAddon implements ICamstackAddon {
  readonly id = 'mock-classifier'
  readonly manifest: AddonDeclaration = {
    id: 'mock-classifier',
    name: 'Mock Classifier',
    version: '0.1.0',
    description: '',
    slot: 'classifier',
  }
  postBrokerStart(): void {}
  async initialize(_ctx: AddonContext): Promise<void> {}
  async shutdown(): Promise<void> {}

  async process(_input: FrameInput | CropInput): Promise<ClassifierOutput> {
    return {
      classifications: [{ class: 'male', score: 0.7 }],
      inferenceMs: 3,
      modelId: 'gender-classifier',
    }
  }
}

// --- Mock error addon ---
class MockErrorAddon implements ICamstackAddon {
  readonly id = 'mock-error'
  readonly manifest: AddonDeclaration = {
    id: 'mock-error',
    name: 'Mock Error',
    version: '0.1.0',
    description: '',
    slot: 'detector',
  }
  postBrokerStart(): void {}
  async initialize(_ctx: AddonContext): Promise<void> {}
  async shutdown(): Promise<void> {}

  async process(_frame: FrameInput): Promise<DetectorOutput> {
    throw new Error('Detection failed')
  }
}

const baseContext: Partial<Omit<AddonContext, 'addonConfig'>> = {
  dataDir: '/tmp/data',
}

/** The engine is irrelevant to routing; any valid choice will do. */
const TEST_ENGINE: PipelineEngineChoice = { runtime: 'python', backend: 'onnx', format: 'onnx' }

function buildSetup(...addonEntries: Array<[string, new () => ICamstackAddon]>): {
  runner: PipelineRunner
  manager: AddonEngineManager
} {
  const loader = new AddonLoader()
  for (const [id, AddonClass] of addonEntries) {
    ;(loader as unknown as { addons: Map<string, unknown> }).addons.set(id, {
      declaration: { id, entry: `./${id}.js`, slot: 'detector' },
      addonClass: AddonClass,
    })
  }

  const manager = new AddonEngineManager(loader, baseContext)
  const resolver = new EngineManagerResolver(manager, new Map())
  const runner = new PipelineRunner(resolver)
  return { runner, manager }
}

describe('PipelineRunner', () => {
  describe('single detector', () => {
    it('runs a single root detector and returns results', async () => {
      const { runner } = buildSetup(['mock-detector', MockDetectorAddon])

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [{ step: 'detect', addon: 'mock-detector' }],
      })

      expect(result.results).toHaveLength(1)
      const step = result.results[0]!
      expect(step.addon).toBe('mock-detector')
      expect(step.slot).toBe('detector')
      expect(step.error).toBeUndefined()
      expect('detections' in step.output).toBe(true)
      if ('detections' in step.output) {
        expect(step.output.detections).toHaveLength(2)
      }
      expect(result.frameTimestamp).toBe(1000)
      expect(result.totalMs).toBeGreaterThanOrEqual(0)
      expect(result.timings['detect']).toBeGreaterThanOrEqual(0)
    })
  })

  describe('tree execution: detector → cropper → classifier', () => {
    it('executes nested pipeline tree', async () => {
      const { runner } = buildSetup(
        ['mock-detector', MockDetectorAddon],
        ['mock-cropper', MockCropperAddon],
        ['mock-classifier', MockClassifierAddon],
      )

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [
          {
            step: 'detect',
            addon: 'mock-detector',
            children: [
              {
                step: 'crop',
                addon: 'mock-cropper',
                children: [{ step: 'classify', addon: 'mock-classifier' }],
              },
            ],
          },
        ],
      })

      // 1 detector + 2 detections * 1 cropper + 2 cropper results * 1 classifier
      // = 1 + 2 + 2*1 crops * 1 classifier each
      // detector: 1 result
      // cropper: 2 results (one per detection)
      // classifier: 2*1 crop per detection = 2 results
      const total = result.results.length
      expect(total).toBe(1 + 2 + 2) // 5 total

      const detectorResults = result.results.filter((r) => r.slot === 'detector')
      const cropperResults = result.results.filter((r) => r.slot === 'cropper')
      const classifierResults = result.results.filter((r) => r.slot === 'classifier')

      expect(detectorResults).toHaveLength(1)
      expect(cropperResults).toHaveLength(2)
      expect(classifierResults).toHaveLength(2)
    })

    it('links parent result IDs correctly', async () => {
      const { runner } = buildSetup(
        ['mock-detector', MockDetectorAddon],
        ['mock-cropper', MockCropperAddon],
      )

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [
          {
            step: 'detect',
            addon: 'mock-detector',
            children: [{ step: 'crop', addon: 'mock-cropper' }],
          },
        ],
      })

      const detectorResult = result.results.find((r) => r.slot === 'detector')!
      const cropperResults = result.results.filter((r) => r.slot === 'cropper')

      expect(detectorResult.parentResultId).toBeUndefined()
      for (const cr of cropperResults) {
        expect(cr.parentResultId).toBe(detectorResult.resultId)
      }
    })
  })

  describe('error handling', () => {
    it('records error and skips children when parent fails', async () => {
      const { runner } = buildSetup(
        ['mock-error', MockErrorAddon],
        ['mock-classifier', MockClassifierAddon],
      )

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [
          {
            step: 'fail',
            addon: 'mock-error',
            children: [{ step: 'classify', addon: 'mock-classifier' }],
          },
        ],
      })

      expect(result.results).toHaveLength(1)
      const step = result.results[0]!
      expect(step.error).toBeDefined()
      expect(step.error?.code).toBe('ADDON_ERROR')
      expect(step.error?.message).toContain('Detection failed')
      expect(step.error?.childrenSkipped).toBe(true)
    })

    it('records error result with empty detections output on failure', async () => {
      const { runner } = buildSetup(['mock-error', MockErrorAddon])

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [{ step: 'fail', addon: 'mock-error' }],
      })

      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.error).toBeDefined()
      const output = result.results[0]?.output
      expect(output && 'detections' in output && output.detections).toHaveLength(0)
    })
  })

  describe('audio node', () => {
    it('executes the audio node independently', async () => {
      const { runner } = buildSetup(
        ['mock-detector', MockDetectorAddon],
        ['mock-classifier', MockClassifierAddon],
      )

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [{ step: 'detect', addon: 'mock-detector' }],
        audio: { step: 'audio-classify', addon: 'mock-classifier' },
      })

      // video: 1 detector; audio: 1 classifier
      expect(result.results).toHaveLength(2)
      const classifierResult = result.results.find((r) => r.addon === 'mock-classifier')
      expect(classifierResult).toBeDefined()
      expect(classifierResult?.slot).toBe('classifier')
    })
  })

  describe('parallel sibling execution', () => {
    it('runs multiple root nodes in sequence', async () => {
      const { runner } = buildSetup(['mock-detector', MockDetectorAddon])

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [
          { step: 'detect-1', addon: 'mock-detector' },
          { step: 'detect-2', addon: 'mock-detector' },
        ],
      })

      expect(result.results).toHaveLength(2)
      expect(result.results[0]?.addon).toBe('mock-detector')
      expect(result.results[1]?.addon).toBe('mock-detector')
      expect(result.timings['detect-1']).toBeGreaterThanOrEqual(0)
      expect(result.timings['detect-2']).toBeGreaterThanOrEqual(0)
    })

    it('runs sibling children in parallel for each detection', async () => {
      const { runner } = buildSetup(
        ['mock-detector', MockDetectorAddon],
        ['mock-cropper', MockCropperAddon],
      )

      const result = await runner.run(mockFrame, {
        engine: TEST_ENGINE,
        video: [
          {
            step: 'detect',
            addon: 'mock-detector',
            // two sibling croppers
            children: [
              { step: 'crop-a', addon: 'mock-cropper' },
              { step: 'crop-b', addon: 'mock-cropper' },
            ],
          },
        ],
      })

      // 1 detector + 2 detections * 2 croppers = 5 results
      expect(result.results).toHaveLength(5)
    })
  })
})
