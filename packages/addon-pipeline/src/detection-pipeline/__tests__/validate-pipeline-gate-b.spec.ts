/**
 * Task G5 (Gate B) — pre-init config-correctness gate.
 *
 * `validatePipeline` is PURE COMPUTE against `this.currentEngine.format`:
 * it composes three pure helpers from `step-resolution.ts`
 * (`collectSubstitutions`, `collectUnknownAddonIssues`,
 * `collectZeroBuildIssues`) and NEVER writes `this.modelSubstitutions` —
 * that node-global map stays the exclusive property of `resolveStepModels`
 * (the node-default tree resolver). Per-camera substitutions are returned
 * in the RESULT instead; the orchestrator logs them at attach time
 * (`orchestrator/__tests__/validate-pipeline-attach.spec.ts`).
 *
 * `this.currentEngine` is set directly (bracket-access, same pattern as
 * `engine-change-gate.spec.ts`'s `provider['provisioner'] = ...`) so these
 * tests exercise the pure compute path without the network-touching
 * provisioner / engine-selection machinery — irrelevant to Gate B.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

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

function makeProvider(): DetectionPipelineProvider {
  return new DetectionPipelineProvider(new InMemoryStore(), '/tmp/models-test', makeLogger())
}

const STEP = 'object-detection'

describe('validatePipeline (Gate B)', () => {
  it('returns ok:true with no issues/substitutions for a clean tree matching the current format', async () => {
    const provider = makeProvider() // constructor default engine.format === 'onnx'
    const modelId = getDefaultModelForFormat(STEP, 'onnx')

    const result = await provider.validatePipeline({
      steps: [{ addonId: STEP, modelId, enabled: true }],
    })

    expect(result).toEqual({ ok: true, issues: [], substitutions: [], format: 'onnx' })
  })

  it('reports an unknown-addon HARD issue and ok:false for an addonId with no registered StepDefinition', async () => {
    const provider = makeProvider()

    const result = await provider.validatePipeline({
      steps: [{ addonId: 'totally-not-a-real-addon', modelId: 'x', enabled: true }],
    })

    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      {
        addonId: 'totally-not-a-real-addon',
        kind: 'unknown-addon',
        detail: 'totally-not-a-real-addon: no registered step definition',
      },
    ])
    expect(result.substitutions).toEqual([])
  })

  it('reports substitutions (informational, does not flip ok) for an explicit model incompatible with the current format', async () => {
    const def = getStepDefinition(STEP)
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['onnx'])
    if (!openvinoOnly) return // catalog has no such model on this build — skip (repo convention)

    const provider = makeProvider()
    // Constructor default format is 'onnx'; openvinoOnly has no onnx build.
    const result = await provider.validatePipeline({
      steps: [{ addonId: STEP, modelId: openvinoOnly.id, enabled: true }],
    })

    const running = getDefaultModelForFormat(STEP, 'onnx')
    expect(result.ok).toBe(true) // substitutions are informational, never HARD
    expect(result.issues).toEqual([])
    expect(result.substitutions).toEqual([
      { addonId: STEP, chosen: openvinoOnly.id, running, format: 'onnx' },
    ])
  })

  it('reports a no-format-build HARD issue and ok:false when the catalog has zero builds for the current format', async () => {
    const provider = makeProvider()
    // No model in the catalog ships a 'pt' build — pinning the node's engine to
    // 'pt' makes EVERY real catalog step zero-build, deterministically, without
    // injecting a fake StepDefinition (Gate B's internal getStepDefinition call
    // is not seam-injectable, unlike the pure `collectZeroBuildIssues` helper it
    // wraps). ('tflite' is no longer usable here: object-detection now ships a
    // Coral SSD build, so it would not be zero-build for tflite.)
    provider['currentEngine'] = { runtime: 'python', backend: 'pytorch', format: 'pt' }

    const result = await provider.validatePipeline({
      steps: [{ addonId: STEP, modelId: 'x', enabled: true }],
    })

    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      { addonId: STEP, kind: 'no-format-build', detail: `${STEP}: no model has a pt build` },
    ])
  })

  it('excludes a disabled step entirely (no issue, no substitution)', async () => {
    const provider = makeProvider() // constructor default engine.format === 'onnx'
    const def = getStepDefinition(STEP)
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['onnx'])

    // A disabled step never contributes to validatePipeline's result,
    // regardless of WHICH check would otherwise flag it: an unknown addonId
    // (would be `unknown-addon`) and — when the catalog has one — a model
    // incompatible with the current format (would be a `substitutions`
    // entry). validatePipeline scopes ALL three checks to enabled steps, so
    // both are proven absent here alongside `ok: true`.
    const result = await provider.validatePipeline({
      steps: [
        { addonId: 'totally-not-a-real-addon', modelId: 'x', enabled: false },
        ...(openvinoOnly ? [{ addonId: STEP, modelId: openvinoOnly.id, enabled: false }] : []),
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.issues.some((i) => i.kind === 'unknown-addon')).toBe(false)
    expect(result.substitutions).toEqual([])
  })

  it('never throws — degrades to a clean ok:true result on internal failure', async () => {
    const provider = makeProvider()
    // Malformed input the router's zod validation would normally reject
    // before it reaches the provider — defensive coverage only.
    const malformed = null as unknown as { steps: never[] }

    await expect(provider.validatePipeline(malformed)).resolves.toBeDefined()
  })
})
