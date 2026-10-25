import { describe, it, expect } from 'vitest'
import { collectSubstitutions, type ResolvableStep } from '../step-resolution.js'
import { getStepDefinition, resolveModelForFormat } from '../registry/step-definitions.js'

// object-detection is a well-known step with multiple format builds in the
// catalog — same pattern used by resolve-model-for-format.spec.ts.
const STEP = 'object-detection'

describe('collectSubstitutions', () => {
  const def = getStepDefinition(STEP)
  const coremlModel = def.models.find((m) => m.formats['coreml'])
  // Non-legacy: a legacy pin falls back to the format default on EVERY format,
  // which would make the "compatible format" case below a substitution too.
  const openvinoOnly = def.models.find(
    (m) => m.legacy !== true && m.formats['openvino'] && !m.formats['coreml'],
  )

  it('returns exactly one substitution for a step (recursing into children) whose chosen model lacks a build for the format', () => {
    if (!openvinoOnly || !coremlModel) return // catalog has no such model on this build — skip

    const tree: ResolvableStep[] = [
      {
        addonId: STEP,
        // Root step's chosen model IS compatible with coreml — no substitution here.
        modelId: coremlModel.id,
        enabled: true,
        children: [
          {
            addonId: STEP,
            // Child's chosen model has an openvino build but no coreml build —
            // resolving for coreml must substitute to the format default.
            modelId: openvinoOnly.id,
            enabled: true,
          },
        ],
      },
    ]

    const result = collectSubstitutions(tree, 'coreml')

    expect(result).toEqual([
      {
        addonId: STEP,
        chosen: openvinoOnly.id,
        running: resolveModelForFormat(STEP, null, 'coreml'),
        format: 'coreml',
      },
    ])
  })

  it('re-running the SAME chosen model against a format where it IS compatible returns an empty array (no staleness)', () => {
    if (!openvinoOnly) return // catalog has no such model on this build — skip

    const tree: ResolvableStep[] = [
      {
        addonId: STEP,
        modelId: openvinoOnly.id,
        enabled: true,
        children: [
          {
            addonId: STEP,
            modelId: openvinoOnly.id,
            enabled: true,
          },
        ],
      },
    ]

    // openvinoOnly has a build for 'openvino' by construction — no substitution
    // anywhere in the tree. This is the regression case: a caller that
    // previously recorded a substitution for this addonId (e.g. from the
    // coreml-format test above) must see it CLEARED, not carried forward,
    // when re-resolving against a compatible format.
    const result = collectSubstitutions(tree, 'openvino')

    expect(result).toEqual([])
  })
})
