/**
 * Tree-builder default-hydration regression.
 *
 * Guards the fix that wired `IPipelineStep.getConfigSchema()` defaults
 * into `ExecutableStep.settings`. Without the hydration step any caller
 * that omits `PipelineDefaultStep.settings` — benchmark runner,
 * first-boot with no per-device overrides, tests that just want a
 * working tree — leaves `rootStep.settings` undefined and the
 * executor's `macroFilterVerdict` short-circuits to 'pass', letting
 * every candidate box pass through.
 *
 * These tests use real step definitions (no mocking) so the
 * `configSchema → defaults` pipeline is exercised end-to-end.
 */
import { describe, it, expect } from 'vitest'
import type { IInferenceEngine, PipelineDefaultStep } from '@camstack/types'

import { buildExecutableTree, type ResolvedStepEngine } from '../pipeline/tree-builder.js'

// A no-op engine — tree-builder only stores the reference, so a stub
// satisfying the interface shape is enough. Tests never call into the
// engine; buildNode just wires it onto the ExecutableStep.
const stubEngine = {
  run: async (): Promise<Record<string, unknown>> => ({}),
  dispose: async (): Promise<void> => {},
} as unknown as IInferenceEngine

const getEngine = (_stepId: string, modelId: string): ResolvedStepEngine => ({
  engine: stubEngine,
  modelId,
})

/**
 * Minimal PipelineDefaultStep factory — fills in every mandatory field
 * with plausible values so tests can focus on the bits that matter
 * (addonId, modelId, optional settings).
 */
function makeStep(opts: {
  readonly addonId: string
  readonly modelId: string
  readonly settings?: Record<string, unknown>
}): PipelineDefaultStep {
  return {
    addonId: opts.addonId,
    addonName: opts.addonId,
    slot: 'detector',
    inputClasses: [],
    outputClasses: [],
    enabled: true,
    modelId: opts.modelId,
    children: [],
    ...(opts.settings ? { settings: opts.settings } : {}),
  }
}

describe('tree-builder — configSchema defaults hydration', () => {
  it('hydrates object-detection per-macro thresholds when settings is omitted', () => {
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({ addonId: 'object-detection', modelId: 'yolov9s' }),
    ]

    const tree = buildExecutableTree(steps, getEngine)
    expect(tree.roots).toHaveLength(1)
    const root = tree.roots[0]!

    expect(root.settings).toBeDefined()
    const s = root.settings!

    // Per-macro minConfidence sliders. Person sits at 0.65 — raised from 0.50
    // on 2026-07-30 after a phantom `person` at 0.5005 (a dead plant) was
    // notified; see person-confidence-floor.spec.ts for the measurement.
    // This assertion is the point of the hydration: without it the runtime
    // filter has no numeric baseline and every candidate box passes.
    expect(s['minConfidencePerson']).toBe(0.65)
    expect(s['minConfidenceVehicle']).toBe(0.5)
    expect(s['minConfidenceAnimal']).toBe(0.5)

    // enabledMacroClasses defaults to all three
    expect(s['enabledMacroClasses']).toEqual(['person', 'vehicle', 'animal'])
  })

  it('user-supplied settings override schema defaults', () => {
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({
        addonId: 'object-detection',
        modelId: 'yolov9s',
        settings: {
          minConfidencePerson: 0.8,
          // vehicle + animal intentionally omitted to verify merge
          enabledMacroClasses: ['person'],
        },
      }),
    ]

    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    const s = root.settings!

    expect(s['minConfidencePerson']).toBe(0.8) // overridden
    expect(s['minConfidenceVehicle']).toBe(0.5) // default preserved
    expect(s['minConfidenceAnimal']).toBe(0.5) // default preserved
    expect(s['enabledMacroClasses']).toEqual(['person']) // overridden
  })

  it('leaves settings undefined when the step declares no schema defaults', () => {
    // face-detection is a cropper with an empty getConfigSchema().
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({ addonId: 'face-detection', modelId: 'scrfd-2_5g' }),
    ]

    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    // No defaults declared → no settings attached.
    expect(root.settings).toBeUndefined()
  })

  // `[SETTINGS-TESTS]` — extended hydration coverage beyond object-detection.
  // Each classifier step below declares a `minConfidence` slider with the
  // step's own `defaultConfidence` as the default. The tree-builder must
  // pull that value into `ExecutableStep.settings` even when the caller
  // supplies no per-step overrides, otherwise `macroFilterVerdict` (or
  // the runner's per-classifier filter) lets everything through.
  it('hydrates the animal classifier minConfidence from its MODEL default (0.80, D741)', () => {
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({ addonId: 'animal-classifier', modelId: 'animal-classifier' }),
    ]
    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    expect(root.settings).toBeDefined()
    // 2026-07-19 confidence gate: raised from 0.2 → 0.5 (the classifier has no
    // reject class and emits an animal on people/floor crops without a floor);
    // 0.80 since D741 — the model's own, measured, least-bad floor.
    expect(root.settings!['minConfidence']).toBe(0.8)
    // enabledClasses defaults to [] — "all species" — not undefined.
    expect(root.settings!['enabledClasses']).toEqual([])
  })

  it('user-supplied enabledClasses on the animal classifier overrides the default', () => {
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({
        addonId: 'animal-classifier',
        modelId: 'animal-classifier',
        settings: { enabledClasses: ['cat', 'dog'], minConfidence: 0.35 },
      }),
    ]
    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    expect(root.settings!['enabledClasses']).toEqual(['cat', 'dog'])
    expect(root.settings!['minConfidence']).toBe(0.35)
  })

  it('merges user-supplied settings with schema defaults non-destructively', () => {
    // Only `minConfidencePerson` is overridden; all other object-detection
    // fields must still come from the schema defaults. This is the
    // contract the hydration layer is supposed to enforce.
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({
        addonId: 'object-detection',
        modelId: 'yolov9s',
        settings: { minConfidencePerson: 0.72 },
      }),
    ]
    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    const s = root.settings!

    expect(s['minConfidencePerson']).toBe(0.72)
    expect(s['minConfidenceVehicle']).toBe(0.5)
    expect(s['minConfidenceAnimal']).toBe(0.5)
    // enabledMacroClasses was not touched by the user → default list.
    expect(s['enabledMacroClasses']).toEqual(['person', 'vehicle', 'animal'])
  })

  it('handles a null user value without crashing (treats as "not set")', () => {
    // `null` is a legitimate user value meaning "unset / use default".
    // The hydration layer must not throw when merging.
    const steps: readonly PipelineDefaultStep[] = [
      makeStep({
        addonId: 'object-detection',
        modelId: 'yolov9s',
        settings: { minConfidencePerson: null },
      }),
    ]
    const tree = buildExecutableTree(steps, getEngine)
    const root = tree.roots[0]!
    // Either the default wins or the null sticks — what matters is
    // that `buildExecutableTree` completed. We assert that the value
    // is not `undefined`, so the executor's threshold check has
    // something numeric (0.5) or explicit null to branch on.
    expect(root.settings!['minConfidencePerson']).not.toBeUndefined()
  })
})
