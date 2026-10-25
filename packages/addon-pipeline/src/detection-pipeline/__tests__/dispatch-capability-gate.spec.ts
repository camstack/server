/**
 * Capability gate + NODE-LOCAL engine fallback on the dispatch path
 * (`DetectionPipelineProvider.resolveStepsForDispatch`) — cam-101 regression,
 * 2026-08-01.
 *
 * A per-call `deviceKey` selects an engine whose format every enabled step
 * must ship a model build for. The gate guarantees:
 *
 *   1. a compatible device dispatch is untouched (model resolved for the
 *      device's format — tflite → the Coral SSD build);
 *   2. a step with ZERO builds for the device's format falls back to the
 *      node's own engine — same node, never another node — and the fallback
 *      is logged ONCE, with `tags: { deviceId }`;
 *   3. when the node's own engine cannot run the step either, the dispatch
 *      throws BEFORE any model download (no 3-retry backoff burning ~5.5s a
 *      frame) and the error names the model, its available formats, and the
 *      engines tried.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assumeKnownClusterRowIsDefaults } from './fixtures/known-cluster-row.js'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat } from '../registry/step-definitions.js'

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

function makeCapturingLogger(lines: CapturedLine[]): IScopedLogger {
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

function makeProvider(lines: CapturedLine[] = []): DetectionPipelineProvider {
  return new DetectionPipelineProvider(
    new InMemoryStore(),
    '/tmp/models-test',
    makeCapturingLogger(lines),
  )
}

// The provider boots on the ONNX floor (onnx/cpu, format 'onnx') until init()
// resolves the real engine — exactly the node-default engine these tests
// fall back to.

describe('resolveStepsForDispatch — capability gate + node-local fallback', () => {
  it('keeps a COMPATIBLE device dispatch on its device, resolving the model for the device format', () => {
    const provider = makeProvider()
    const result = provider['resolveStepsForDispatch']({
      steps: [{ addonId: 'object-detection', modelId: undefined, enabled: true }],
      deviceKey: 'edgetpu:usb',
      deviceId: 101,
      plane: undefined,
    })
    expect(result.deviceKey).toBe('edgetpu:usb')
    // The auto model must be a tflite build (the cam-101 bug returned the
    // formatless yolo26n here), i.e. the step's tflite default.
    expect(result.steps[0]!.modelId).toBe(getDefaultModelForFormat('object-detection', 'tflite'))
  })

  it('falls back to the NODE engine when a step has zero builds for the device format, and logs it once with tags.deviceId', () => {
    const lines: CapturedLine[] = []
    const provider = makeProvider(lines)
    // face-embedding ships onnx/coreml/openvino — no tflite build at all.
    const dispatch = (): ReturnType<(typeof provider)['resolveStepsForDispatch']> =>
      provider['resolveStepsForDispatch']({
        steps: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
        deviceKey: 'edgetpu:usb',
        deviceId: 101,
        plane: undefined,
      })
    const result = dispatch()
    // Node-local fallback: deviceKey dropped (node default pool serves it),
    // model re-resolved for the NODE's format (onnx floor in this harness).
    expect(result.deviceKey).toBeUndefined()
    expect(result.steps[0]!.modelId).toBe(getDefaultModelForFormat('face-embedding', 'onnx'))

    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('falling back to the node-local default engine')
    expect(warns[0]!.context).toMatchObject({
      tags: { deviceId: 101 },
      meta: { deviceKey: 'edgetpu:usb', deviceFormat: 'tflite', steps: ['face-embedding'] },
    })

    // Per-frame path: the SAME dispatch again must not log again (dedup).
    dispatch()
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('throws FAST and loud (once) when the node engine cannot run the step either', () => {
    const lines: CapturedLine[] = []
    const provider = makeProvider(lines)
    // Force the node default onto tflite too, so neither the device nor the
    // node engine can run face-embedding.
    provider['currentEngine'] = {
      runtime: 'python',
      backend: 'edgetpu',
      format: 'tflite',
      device: 'usb',
    }
    const dispatch = (): unknown =>
      provider['resolveStepsForDispatch']({
        steps: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
        deviceKey: 'edgetpu:usb',
        deviceId: 101,
        plane: undefined,
      })
    expect(dispatch).toThrowError(/face-embedding/)
    expect(dispatch).toThrowError(/no tflite build/)
    expect(dispatch).toThrowError(/Engines tried/)
    // The error is logged ONCE even though the throw fires per dispatch.
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1)
  })

  it('a plain node dispatch (no deviceKey) with a runnable step passes through untouched', () => {
    const provider = makeProvider()
    const result = provider['resolveStepsForDispatch']({
      steps: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
      deviceKey: undefined,
      deviceId: undefined,
      plane: undefined,
    })
    expect(result.deviceKey).toBeUndefined()
    expect(result.steps[0]!.modelId).toBe(getDefaultModelForFormat('face-embedding', 'onnx'))
  })

  it('DISABLED steps do not trigger the gate (only steps that will actually load models count)', () => {
    const provider = makeProvider()
    const result = provider['resolveStepsForDispatch']({
      steps: [
        { addonId: 'object-detection', modelId: undefined, enabled: true },
        { addonId: 'face-embedding', modelId: undefined, enabled: false },
      ],
      deviceKey: 'edgetpu:usb',
      deviceId: 101,
      plane: undefined,
    })
    expect(result.deviceKey).toBe('edgetpu:usb')
  })
})

// ---------------------------------------------------------------------------
// Per-step split (2026-08-01 evening): on the LIVE `'frame'` plane the ROOT
// decides the dispatch device — a detail child never bounces the whole tree.
// The original whole-tree gate defeated the design requirement that devices
// compensate for each other's missing steps: enable the Coral and ONE
// tflite-less child (face-embedding) sent the root back to openvino, so the
// Coral was elected, warm, and did nothing.
// ---------------------------------------------------------------------------

describe('resolveStepsForDispatch — frame plane: the ROOT decides, detail children defer to the device jump', () => {
  // The realistic Coral tree: object-detection (tflite SSD build exists),
  // face-detection (only the LEGACY Coral face stub has a tflite build — not
  // loadable, D657), face-embedding (NO tflite build anywhere — the step that
  // used to bounce the whole tree).
  const coralTree = [
    {
      addonId: 'object-detection',
      modelId: undefined,
      enabled: true,
      children: [
        {
          addonId: 'face-detection',
          modelId: undefined,
          enabled: true,
          children: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
        },
      ],
    },
  ]

  it('keeps the ROOT on the Coral when only a detail child lacks a tflite build — the child is pruned from THIS dispatch, loudly, once', () => {
    const lines: CapturedLine[] = []
    const provider = makeProvider(lines)
    const dispatch = (): ReturnType<(typeof provider)['resolveStepsForDispatch']> =>
      provider['resolveStepsForDispatch']({
        steps: coralTree,
        deviceKey: 'edgetpu:usb',
        deviceId: 101,
        plane: 'frame',
      })
    const result = dispatch()
    // Pre-fix this was `undefined` (whole-tree bounce to the node engine).
    expect(result.deviceKey).toBe('edgetpu:usb')
    expect(result.steps[0]!.modelId).toBe(getDefaultModelForFormat('object-detection', 'tflite'))
    // D657: the face SUBTREE is judged whole, with the runner's own jump
    // predicate. Neither face-detection (legacy stub only) nor face-embedding
    // can run on tflite, so the subtree is pruned from THIS dispatch — its
    // model is never loaded on the Coral. Before D657 face-detection was kept
    // here, resolved to `scrfd-2.5g` (no tflite build), and its failed load
    // took the root's with it.
    expect(result.steps[0]!.children ?? []).toHaveLength(0)
    // NOT silent, and NOT a bounce: an info deferral with tags.deviceId, no warn.
    const infos = lines.filter(
      (l) => l.level === 'info' && l.message.includes('deferred to the detail-plane device jump'),
    )
    expect(infos).toHaveLength(1)
    expect(infos[0]!.context).toMatchObject({
      tags: { deviceId: 101 },
      meta: { deviceKey: 'edgetpu:usb', deviceFormat: 'tflite', steps: ['face-detection'] },
    })
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0)
    // Per-frame path: the SAME dispatch again must not log again (dedup).
    dispatch()
    expect(
      lines.filter(
        (l) => l.level === 'info' && l.message.includes('deferred to the detail-plane device jump'),
      ),
    ).toHaveLength(1)
  })

  it('still falls the WHOLE tree back when the ROOT itself cannot run on the device', () => {
    const lines: CapturedLine[] = []
    const provider = makeProvider(lines)
    // A top-level step EXECUTES on the frame plane, so it is the "root" here:
    // face-embedding has no tflite build → the whole call leaves the device.
    const result = provider['resolveStepsForDispatch']({
      steps: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
      deviceKey: 'edgetpu:usb',
      deviceId: 101,
      plane: 'frame',
    })
    expect(result.deviceKey).toBeUndefined()
    expect(result.steps[0]!.modelId).toBe(getDefaultModelForFormat('face-embedding', 'onnx'))
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('falling back to the node-local default engine')
  })

  it("a 'full'-plane call (detail subtree / benchmark) keeps the whole-tree gate — one call runs on one pool", () => {
    const lines: CapturedLine[] = []
    const provider = makeProvider(lines)
    // The face subtree dispatched as ONE call: the executor runs parent AND
    // child inline on a single pool, so an unrunnable child must still bounce
    // the call — splitting happens a plane above, at the runner's device jump.
    const result = provider['resolveStepsForDispatch']({
      steps: [
        {
          addonId: 'face-detection',
          modelId: undefined,
          enabled: true,
          children: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
        },
      ],
      deviceKey: 'edgetpu:usb',
      deviceId: 101,
      plane: 'full',
    })
    expect(result.deviceKey).toBeUndefined()
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    // face-detection runs on tflite since YuNet's Coral build (D710); the
    // embedding child does not, and one child is enough to bounce the call.
    expect(warns[0]!.context).toMatchObject({
      meta: { steps: ['face-embedding'] },
    })
  })
})
