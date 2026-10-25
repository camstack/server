/**
 * (c) A node that cannot serve the cluster model REFUSES — with the right line.
 *
 * This is the test that has to be built to fail, because passing is what
 * substitution looks like from outside: the step runs, a vector comes back,
 * nothing errors. The only observable difference is a log line and the model
 * that actually ran, so both are asserted here against a fabricated node whose
 * engine format ships none of the cluster's chosen builds.
 *
 * It uses the REAL provider and the REAL catalog. A stub catalog would only
 * prove the stub.
 */
import type { IScopedLogger } from '@camstack/types'
import { DEFAULT_CLUSTER_STEP_MODELS } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assumeKnownClusterRowIsDefaults } from './fixtures/known-cluster-row.js'
import { DetectionPipelineProvider } from '../provider.js'
import { resolveInputSteps } from '../step-resolution.js'
import { getStepDefinition } from '../registry/step-definitions.js'

beforeEach(() => {
  assumeKnownClusterRowIsDefaults()
})
afterEach(() => {
  vi.restoreAllMocks()
})

interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: Record<string, unknown> | undefined
}

function capturingLogger(lines: CapturedLine[]): IScopedLogger {
  const capture =
    (level: CapturedLine['level']) =>
    (message: string, context?: Record<string, unknown>): void => {
      lines.push({ level, message, context })
    }
  const logger: IScopedLogger = {
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class InMemoryStore {
  private data: Record<string, unknown> = {}
  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}

/**
 * The node this test fabricates: a Coral, whose only format is `tflite`.
 *
 * Not an invented format — `edgetpu:usb` is a real device key in this fleet,
 * and no face or CLIP embedder in the catalog has ever shipped a tflite build.
 * So this is the fleet's actual worst case, not a hypothetical one.
 */
const CORAL_DEVICE_KEY = 'edgetpu:usb'
const CORAL_FORMAT = 'tflite'

const faceTree = [
  {
    addonId: 'object-detection',
    enabled: true,
    children: [
      {
        addonId: 'face-detection',
        enabled: true,
        children: [{ addonId: 'face-embedding', enabled: true, children: [] }],
      },
    ],
  },
]

describe('a node with no build of the cluster model', () => {
  it('the premise holds: no face embedder in the catalog ships tflite', () => {
    // If this ever stops being true the rest of the file proves nothing, so it
    // is asserted rather than assumed.
    const models = getStepDefinition('face-embedding').models
    expect(models.every((m) => m.formats[CORAL_FORMAT] === undefined)).toBe(true)
  })

  it('REFUSES to substitute, and names the model, the format and what it could have run', () => {
    const out = resolveInputSteps(faceTree, CORAL_FORMAT, undefined, DEFAULT_CLUSTER_STEP_MODELS)
    expect(out.diagnostics.clusterRefusals).toHaveLength(1)
    const refusal = out.diagnostics.clusterRefusals[0]!
    expect(refusal.stepId).toBe('face-embedding')
    expect(refusal.modelId).toBe(DEFAULT_CLUSTER_STEP_MODELS['face-embedding'])
    expect(refusal.format).toBe(CORAL_FORMAT)
    expect(refusal.formatsShipped).toContain('onnx')
    // The refusal is NOT a substitution: nothing else was quietly chosen.
    expect(out.diagnostics.substitutions).toEqual([])
  })

  it('the step keeps the cluster model — so the node-local fallback can still rescue it', () => {
    // The refusal forbids substitution; it does not delete the work. On a
    // mixed-accelerator node the existing fallback moves the step to an engine
    // that CAN serve it, and that rescue keys off exactly this state.
    const out = resolveInputSteps(faceTree, CORAL_FORMAT, undefined, DEFAULT_CLUSTER_STEP_MODELS)
    const faceDetection = out.steps[0]?.children?.find((c) => c.addonId === 'face-detection')
    const embedding = faceDetection?.children?.find((c) => c.addonId === 'face-embedding')
    expect(embedding?.modelId).toBe(DEFAULT_CLUSTER_STEP_MODELS['face-embedding'])
  })

  it('through the REAL dispatch path, the Coral never runs a substitute encoder', () => {
    const lines: CapturedLine[] = []
    const provider = new DetectionPipelineProvider(
      new InMemoryStore(),
      '/tmp/models-test',
      capturingLogger(lines),
    )
    const result = provider['resolveStepsForDispatch']({
      steps: faceTree,
      deviceKey: CORAL_DEVICE_KEY,
      deviceId: 101,
      plane: undefined,
    })

    // The whole tree bounced to the node's own engine (onnx on the boot floor),
    // which is where a face embedder actually exists — the pre-existing rescue,
    // preserved.
    expect(result.deviceKey).toBeUndefined()
    const faceDetection = result.steps[0]!.children?.find((c) => c.addonId === 'face-detection')
    const embedding = faceDetection?.children?.find((c) => c.addonId === 'face-embedding')
    // …and it runs the CLUSTER model there, not some format default.
    expect(embedding?.modelId).toBe(DEFAULT_CLUSTER_STEP_MODELS['face-embedding'])

    // No cluster-refusal warning: on this node the step is served, so warning
    // would be a false alarm on every Coral in the fleet — which is how a real
    // warning stops being read.
    expect(
      lines.filter((l) => l.level === 'warn' && l.message.includes('cluster-scoped step')),
    ).toEqual([])
  })

  it('a cluster model NO engine on the node can serve is loud, and tagged with the camera', () => {
    const lines: CapturedLine[] = []
    const provider = new DetectionPipelineProvider(
      new InMemoryStore(),
      '/tmp/models-test',
      capturingLogger(lines),
    )
    // `auraface-r100` is a real catalog entry; pretend the operator chose
    // a build the node's own engine also lacks by resolving against tflite
    // directly — the state a single-accelerator Coral node would be in.
    const refusals = resolveInputSteps(faceTree, CORAL_FORMAT, undefined, {
      ...DEFAULT_CLUSTER_STEP_MODELS,
      'face-embedding': 'auraface-r100',
    }).diagnostics.clusterRefusals
    provider['logClusterRefusals'](refusals, 101, 'edgetpu/usb (tflite)')

    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('cluster-scoped step')
    expect(warns[0]!.context).toMatchObject({
      // Per CLAUDE.md: every log line about a device carries the numeric id,
      // because this question is always asked per-camera.
      tags: { deviceId: 101 },
      meta: {
        step: 'face-embedding',
        clusterModelId: 'auraface-r100',
        format: CORAL_FORMAT,
        engine: 'edgetpu/usb (tflite)',
      },
    })
    // The line has to say what to DO, not only what happened.
    expect(String((warns[0]!.context as { meta: { remedy: string } }).meta.remedy)).toContain(
      'tflite',
    )
  })

  it('deduplicates: a fleet of cameras on one bad node produces ONE line', () => {
    const lines: CapturedLine[] = []
    const provider = new DetectionPipelineProvider(
      new InMemoryStore(),
      '/tmp/models-test',
      capturingLogger(lines),
    )
    const refusals = resolveInputSteps(
      faceTree,
      CORAL_FORMAT,
      undefined,
      DEFAULT_CLUSTER_STEP_MODELS,
    ).diagnostics.clusterRefusals
    for (const deviceId of [101, 102, 108, 104]) {
      provider['logClusterRefusals'](refusals, deviceId, 'edgetpu/usb (tflite)')
    }
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })
})
