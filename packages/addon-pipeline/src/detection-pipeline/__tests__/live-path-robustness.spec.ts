import { describe, it, expect } from 'vitest'
import { resolveInputSteps } from '../step-resolution.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'
import type { PipelineStepInput } from '@camstack/types'

// `resolveInputSteps` is the pure seam behind the LIVE per-camera dispatch
// path (`DetectionPipelineProvider.inputStepsToPipelineSteps`), which runs
// once per decoded frame. It must never throw on a bad step config, and
// must report (never silently apply) a runtime model substitution — Task
// G2 (see docs/superpowers/sdd/task-g2-report.md).
describe('resolveInputSteps — live dispatch robustness (Task G2)', () => {
  it('drops an unknown addonId instead of throwing, and reports it in diagnostics', () => {
    const steps: readonly PipelineStepInput[] = [
      { addonId: 'totally-not-a-real-addon', modelId: undefined, enabled: true },
      { addonId: 'object-detection', modelId: undefined, enabled: true },
    ]

    const { steps: resolved, diagnostics } = resolveInputSteps(steps, 'coreml')

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.addonId).toBe('object-detection')
    expect(diagnostics.unknownAddonIds).toEqual(['totally-not-a-real-addon'])
  })

  it('drops an unknown addonId nested in children without throwing', () => {
    const steps: readonly PipelineStepInput[] = [
      {
        addonId: 'object-detection',
        modelId: undefined,
        enabled: true,
        children: [{ addonId: 'bogus-child-addon', modelId: undefined, enabled: true }],
      },
    ]

    const { steps: resolved, diagnostics } = resolveInputSteps(steps, 'coreml')

    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.children).toEqual([])
    expect(diagnostics.unknownAddonIds).toEqual(['bogus-child-addon'])
  })

  it('resolves a step with no unknown addons and no substitutions cleanly (diagnostics empty)', () => {
    const steps: readonly PipelineStepInput[] = [
      { addonId: 'object-detection', modelId: undefined, enabled: true },
    ]

    const { diagnostics } = resolveInputSteps(steps, 'coreml')

    expect(diagnostics.unknownAddonIds).toEqual([])
    expect(diagnostics.substitutions).toEqual([])
  })

  it('resolves an incompatible explicit model to the format default and reports the substitution (never throws, never silently applies)', () => {
    const def = getStepDefinition('object-detection')
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['coreml'])
    if (!openvinoOnly) return // catalog shape guard — mirrors provider-model-resolution.spec.ts

    const steps: readonly PipelineStepInput[] = [
      { addonId: 'object-detection', modelId: openvinoOnly.id, enabled: true },
    ]

    const { steps: resolved, diagnostics } = resolveInputSteps(steps, 'coreml')

    const expectedDefault = getDefaultModelForFormat('object-detection', 'coreml')
    expect(resolved[0]!.modelId).toBe(expectedDefault)
    expect(diagnostics.substitutions).toEqual([
      {
        addonId: 'object-detection',
        chosen: openvinoOnly.id,
        running: expectedDefault,
        format: 'coreml',
      },
    ])
  })

  it('does not report a substitution when modelId is absent (null) — that is a default resolution, not a substitution', () => {
    const steps: readonly PipelineStepInput[] = [
      { addonId: 'object-detection', modelId: undefined, enabled: true },
    ]

    const { diagnostics } = resolveInputSteps(steps, 'coreml')

    expect(diagnostics.substitutions).toEqual([])
  })
})
