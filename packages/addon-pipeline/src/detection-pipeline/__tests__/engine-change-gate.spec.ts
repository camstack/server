/**
 * Task G4 (Gate A) — config-correctness gate at engine change.
 *
 * Today the engine READINESS is gated (provisioner state machine +
 * `assertEngineReady`), but config CORRECTNESS is only a lazy
 * `currentSteps = null` invalidation whose substitution-surfacing may never
 * run on a camera-only node (nothing calls `nodeDefaultSteps()` there). Gate A
 * makes it EAGER: on every actual engine change, `onEngineSelectionChanged`
 * re-resolves the node-default tree for the new format right away and
 * populates `getEngineProvisioning().configIssues` with human-readable
 * issues — model substitutions ("chose X, running Y") and zero-build steps
 * ("no model has a <format> build").
 *
 * Two seams are exercised:
 *  1. The pure `collectZeroBuildIssues` helper (step-resolution.ts), with an
 *     INJECTED `getStepDef` — the real catalog currently has no video step
 *     whose entire model set lacks a given format (every step has at least
 *     one model per format), so the zero-build branch is otherwise
 *     unreachable black-box. Injection is the seam that makes it testable
 *     without `vi.mock`.
 *  2. The provider's `onEngineSelectionChanged` → `getEngineProvisioning()`
 *     merge. Since the executor-seed removal `nodeDefaultSteps` is PURE — the
 *     node-default tree is computed hardware-aware on demand and can never
 *     carry an operator model pin — so the node-default substitution channel
 *     is structurally clean: a clean engine change yields NO configIssues,
 *     even when a stale legacy seed with an incompatible pin still sits in
 *     the store (it is ignored). Per-camera pin substitutions surface via
 *     the LIVE dispatch path diagnostics + Gate B (`validatePipeline`), not
 *     Gate A. The provisioner is swapped for a no-op-effects
 *     `EngineProvisioner` so `startProvisioningForCurrentEngine()` never
 *     touches the network.
 */

import type { IScopedLogger, ModelCatalogEntry, PipelineEngineChoice } from '@camstack/types'
import { describe, expect, it, afterEach } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import { collectZeroBuildIssues } from '../step-resolution.js'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'
import { getStepDefinition } from '../registry/step-definitions.js'
import type { StepDefinition } from '@camstack/types'

// ---------------------------------------------------------------------------
// Test doubles (mirror engine-auto-resolve.spec.ts / engine-catalog-gate.spec.ts)
// ---------------------------------------------------------------------------

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class InMemoryStore {
  data: Record<string, unknown> = {}
  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}

function makeProvider(store: InMemoryStore): DetectionPipelineProvider {
  return new DetectionPipelineProvider(store, '/tmp/models-test', makeLogger())
}

function engine(
  backend: string,
  format: PipelineEngineChoice['format'],
  device: string,
): PipelineEngineChoice {
  return { runtime: 'python', backend, format, device }
}

const ORIG_PLATFORM = process.platform
const ORIG_ARCH = process.arch
function stubPlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  Object.defineProperty(process, 'arch', { value: ORIG_ARCH, configurable: true })
})

// ---------------------------------------------------------------------------
// Seam 1 — collectZeroBuildIssues (pure, injected getStepDef)
// ---------------------------------------------------------------------------

function fakeModel(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: 'fake-model',
    name: 'Fake Model',
    description: 'Fake model for zero-build unit test',
    inputSize: { width: 1, height: 1 },
    labels: [],
    formats: {},
    ...overrides,
  }
}

function fakeStepDefinition(overrides: Partial<StepDefinition>): StepDefinition {
  return {
    id: 'fake-step',
    name: 'Fake Step',
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['thing'],
    models: [],
    defaultModelId: 'fake-model',
    defaultConfidence: 0.5,
    ...overrides,
  }
}

describe('collectZeroBuildIssues', () => {
  it('flags a step whose catalog has zero models with a build for the format', () => {
    const def = fakeStepDefinition({
      id: 'onnx-only-step',
      models: [fakeModel({ id: 'm1', formats: { onnx: { url: 'x', sizeMB: 1 } } })],
    })
    const result = collectZeroBuildIssues([{ addonId: 'onnx-only-step' }], 'coreml', () => def)
    expect(result).toEqual([{ addonId: 'onnx-only-step', format: 'coreml' }])
  })

  it('does not flag a step with at least one model with a build for the format', () => {
    const def = fakeStepDefinition({
      id: 'compatible-step',
      models: [
        fakeModel({ id: 'm1', formats: { onnx: { url: 'x', sizeMB: 1 } } }),
        fakeModel({ id: 'm2', formats: { coreml: { url: 'y', sizeMB: 1 } } }),
      ],
    })
    const result = collectZeroBuildIssues([{ addonId: 'compatible-step' }], 'coreml', () => def)
    expect(result).toEqual([])
  })

  it('skips an unknown/custom addonId rather than throwing', () => {
    const throwing = (): StepDefinition => {
      throw new Error('unknown step')
    }
    expect(() =>
      collectZeroBuildIssues([{ addonId: 'no-such-step' }], 'coreml', throwing),
    ).not.toThrow()
    expect(collectZeroBuildIssues([{ addonId: 'no-such-step' }], 'coreml', throwing)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Seam 2 — provider recomputeConfigIssues → getEngineProvisioning merge
//
// The elected single-engine cascade was removed: the node-default engine is
// derived from hardware and `recomputeConfigIssues` is driven once at boot
// (not on an operator engine change). This seam drives it directly with the
// node-default engine pinned onto the provider's `currentEngine` field.
// ---------------------------------------------------------------------------

const STEP = 'object-detection'

describe('Gate A — provider eager config-issue recompute for the node default', () => {
  it('ignores a stale legacy seed with an incompatible pin — the pure default tree yields NO configIssues', async () => {
    stubPlatform('darwin', 'arm64')

    const def = getStepDefinition(STEP)
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['coreml'])
    if (!openvinoOnly) return // catalog has no such model on this build — skip (repo convention)

    const store = new InMemoryStore()
    // A LEGACY seed (pre executor-seed removal) pinning a coreml-incompatible
    // model. `nodeDefaultSteps` is pure now — this blob must be IGNORED, so no
    // substitution issue may surface from it.
    store.data['pipelineSteps'] = JSON.stringify([
      {
        addonId: STEP,
        modelId: openvinoOnly.id,
        enabled: true,
        children: [],
      },
    ])

    const provider = makeProvider(store)
    // The node default derives to coreml on a Mac; pin it directly (the derive
    // is exercised by resolveAutoEngine's own tests).
    provider['currentEngine'] = engine('coreml', 'coreml', 'all')

    await provider['recomputeConfigIssues']()

    // The pure hardware-aware default tree resolves natively for coreml —
    // no substitution, no zero-build issue. The stale pin never surfaces:
    // the detector carries the HARDWARE-AWARE default (apple-ane class), not
    // the stale pinned model.
    expect(provider.getEngineProvisioning().configIssues).toBeUndefined()
    const steps = await provider['nodeDefaultSteps']()
    const detector = steps?.find((step) => step.slot === 'detector')
    expect(detector?.modelId).not.toBe(openvinoOnly.id)
    expect(detector?.modelId).toBe(resolveDefaultDetectionModel('coreml', null, 'coreml'))
  })

  it('leaves configIssues empty for a clean node default (default tree resolves natively)', async () => {
    stubPlatform('linux', 'x64')

    const store = new InMemoryStore()
    // No persisted `pipelineSteps` — nodeDefaultSteps() bootstraps the
    // canonical default tree, whose modelIds are `getDefaultModelForFormat`
    // by construction (see buildDefaultStepTree) — never substituted.

    const provider = makeProvider(store)
    provider['currentEngine'] = engine('openvino', 'openvino', 'auto')

    await provider['recomputeConfigIssues']()

    expect(provider.getEngineProvisioning().configIssues).toBeUndefined()
  })
})
