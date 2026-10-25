/**
 * Run ONE enrichment step against caller-supplied pixels, with no camera
 * session. Backs the `pipelineRunner.runStatelessStep` cap method.
 *
 * ## Why this is not a mode of `runDetailSubtree`
 *
 * `runDetailSubtree` resolves its step tree from the LIVE ATTACH STATE
 * (`resolveChildSteps` → `null` when the camera is detached). That is right for
 * it — its whole reason to exist is a frame HANDLE, which is only resolvable
 * while a decode session is open. It is wrong for anything walking history:
 * cameras run `detectionMode: 'on-motion'` and detach ~30 s after motion stops,
 * so a fleet-wide embedding rebuild found most cameras detached. Measured on
 * the live hub, 2026-08-06: 1125 tracks scanned, 121 rebuilt, 601 refused with
 * `camera is not attached`.
 *
 * A caller that ships its own pixels needs none of that. So this path resolves
 * the step from the CATALOG, takes the model as an explicit pin, and holds no
 * per-camera state at all — which is what lets the caller place it on any node.
 *
 * ## The two things it must not get wrong
 *
 * 1. **The crop rectangle stays the single shared derivation.** This module
 *    calls {@link cutFromFullFrame} — the live path's own cutter — and never
 *    `deriveDetailCropRect` directly. `scripts/check-clip-crop-single-owner.ts`
 *    permits exactly one importer of the derivation, and that guard IS
 *    [D52](../../../../docs/decisions/adr-0052.md): two derivations put two
 *    incomparable feature spaces in one vector index.
 * 2. **The pinned model is run or refused, never substituted.** The executor's
 *    `resolveModelForFormat` swaps a model that has no build for the node's
 *    engine format for that format's default, silently, with one info line. A
 *    pass that round-robins nodes would then fill one index from several
 *    encoders — D52 one level down, and this time with nothing in the stored
 *    data to hint at it. So servability is decided HERE, before dispatch, and
 *    a node that cannot serve the pin says so.
 *
 * Deps-injected and framework-free for the same reason the detail subtree is:
 * the decision table above is the part worth testing, and it should be testable
 * without a broker, a catalog or an engine pool.
 */
import type {
  DetailCropConvention,
  DetailResult,
  FrameResult,
  IScopedLogger,
  ModelFormat,
  PipelineStepInputOutput,
  RunStatelessStepInput,
  RunStatelessStepResult,
  StatelessStepRefusal,
  StepDefinition,
} from '@camstack/types'
import { cutFromFullFrame, toDetailResult } from './detail-subtree.js'

export interface StatelessStepDeps {
  /** The cluster node this runner is on — echoed on every answer so a fleet
   *  pass can name the node that ran (or refused) each piece of work. */
  readonly nodeId: string
  /** Catalog lookup; `null` for an id this node does not know. */
  lookupStep(stepId: string): StepDefinition | null
  /**
   * The model format this node would dispatch on for a call with NO `deviceKey`
   * — i.e. its selected engine's format. `null` when it cannot be determined,
   * which is a refusal: an unchecked pin is a silent substitution waiting to
   * happen.
   */
  executionFormat(): Promise<ModelFormat | null>
  /** The ONE cluster-wide crop convention (see `crop-convention-source.ts`). */
  resolveCropConvention(): DetailCropConvention
  /**
   * Node-local `pipelineExecutor.runPipeline` on the `'full'` plane, with NO
   * `deviceKey`: the step-tree device jump reads the attach config's device
   * roster, and there is no attach here. The step runs on the node's default
   * engine — which is also the engine {@link StatelessStepDeps.executionFormat}
   * reports, so the servability check and the dispatch agree.
   */
  runPipeline(
    steps: readonly PipelineStepInputOutput[],
    imageJpeg: Buffer,
    sourceDeviceId: number,
  ): Promise<FrameResult | null>
  /** Where refusals are announced. Every one of them is logged, tagged with
   *  the source deviceId — a refused piece of work that logs nothing is
   *  indistinguishable from work that was never dispatched. */
  readonly logger: Pick<IScopedLogger, 'warn'>
}

/**
 * Can this node run `modelId` for `step` on `format`?
 *
 * Three answers, not two, because a model the catalog does not know behaves
 * differently from one it does: `resolveModelForFormat` returns an unknown id
 * UNCHANGED (the operator owns a custom model's format compatibility), so a
 * custom pin cannot be substituted and refusing it would strand an operator who
 * deliberately chose one. Only a KNOWN model with no build for the format is a
 * refusal — that is precisely the case the executor would swap.
 */
export type ModelServability =
  /** In the catalog, with a build for this format — the pin will be honoured. */
  | { readonly kind: 'catalog-build' }
  /** Not in the catalog at all — nothing can substitute it, so it is allowed. */
  | { readonly kind: 'custom-model' }
  /** In the catalog, no build for this format — the executor WOULD substitute. */
  | { readonly kind: 'no-build'; readonly availableFormats: readonly string[] }

export function modelServability(
  step: StepDefinition,
  modelId: string,
  format: ModelFormat,
): ModelServability {
  const entry = step.models.find((m) => m.id === modelId)
  if (entry === undefined) return { kind: 'custom-model' }
  if (entry.formats[format] !== undefined) return { kind: 'catalog-build' }
  return { kind: 'no-build', availableFormats: Object.keys(entry.formats) }
}

/** Build the refusal answer, log it, and return it — never one without the other. */
function refuse(
  deps: StatelessStepDeps,
  input: RunStatelessStepInput,
  reason: StatelessStepRefusal,
  detail: string,
): RunStatelessStepResult {
  deps.logger.warn('runStatelessStep refused', {
    tags: { deviceId: input.sourceDeviceId },
    meta: {
      nodeId: deps.nodeId,
      stepId: input.stepId,
      modelId: input.modelId,
      reason,
      detail,
    },
  })
  return { kind: 'refused', nodeId: deps.nodeId, reason, detail }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Run one step over one subject. See the module header for the two invariants.
 *
 * Never throws: every failure mode is a named, logged refusal, because the
 * caller is a bulk pass whose counters are the only signal an operator gets and
 * a thrown error there reads as "the whole pass broke".
 */
export async function runStatelessStep(
  deps: StatelessStepDeps,
  input: RunStatelessStepInput,
): Promise<RunStatelessStepResult> {
  const definition = deps.lookupStep(input.stepId)
  if (definition === null) {
    return refuse(
      deps,
      input,
      'unknown-step',
      `this node's step catalog has no "${input.stepId}" — version skew, or a custom step that is not installed here`,
    )
  }

  if (input.bbox.w <= 0 || input.bbox.h <= 0) {
    return refuse(
      deps,
      input,
      'unreadable-frame',
      `degenerate normalized bbox ${JSON.stringify(input.bbox)} — nothing to crop`,
    )
  }

  const format = await deps.executionFormat()
  if (format === null) {
    return refuse(
      deps,
      input,
      'model-not-servable',
      'this node could not report the engine format it would dispatch on, so the model pin cannot be verified — running anyway would risk a silent format substitution',
    )
  }

  const servability = modelServability(definition, input.modelId, format)
  if (servability.kind === 'no-build') {
    return refuse(
      deps,
      input,
      'model-not-servable',
      `model "${input.modelId}" has no ${format} build (catalog ships: ${servability.availableFormats.join(', ') || 'none'}) — this node would have substituted the ${format} default`,
    )
  }

  // A decode that THROWS and one that yields no dimensions are the same
  // outcome — no pixels — and both go through `refuse` so neither can produce a
  // silent null. The thrown message is carried into the detail rather than
  // logged separately, so the count of refusal lines stays one per refusal.
  let decodeError: string | null = null
  const crop = await cutFromFullFrame(
    input.frameJpeg,
    { kind: 'normalized', rect: input.bbox },
    deps.resolveCropConvention(),
  ).catch((err: unknown) => {
    decodeError = errorMessage(err)
    return null
  })
  if (crop === null) {
    return refuse(
      deps,
      input,
      'unreadable-frame',
      decodeError ?? 'the supplied frame decoded to no readable dimensions',
    )
  }

  // The step tree is synthesised, not read from an attachment: one enabled root
  // carrying the PINNED model. No `jumpDeviceKey` — the jump roster lives on the
  // attach config, which does not exist on this path.
  const steps: readonly PipelineStepInputOutput[] = [
    { addonId: input.stepId, modelId: input.modelId, enabled: true },
  ]

  let result: FrameResult | null
  try {
    result = await deps.runPipeline(steps, crop.jpeg, input.sourceDeviceId)
  } catch (err: unknown) {
    return refuse(deps, input, 'execution-failed', errorMessage(err))
  }
  if (result === null) {
    return refuse(
      deps,
      input,
      'execution-failed',
      'the executor returned no frame result for the crop',
    )
  }

  // The model that RAN, as the executor stamped it from the variant it
  // resolved — never the pin echoed back. Echoing `input.modelId` made the
  // caller's "did the node run my pin?" check (`readRebuildStepOutcome`) a
  // tautology: a cluster row that moved mid-pass overwrites a cluster-scoped
  // step's model inside `runPipeline`, and the pass would have filed the new
  // model's vectors under the pinned one (D658). No stamp ⇒ refused by name.
  const ranModelId = result.rootModelId
  if (ranModelId === undefined || ranModelId === '') {
    return refuse(
      deps,
      input,
      'execution-failed',
      `the executor result names no model — refusing rather than assuming "${input.modelId}" ran`,
    )
  }
  // A pass pinned to ONE model gets that model or nothing (D54). Returning
  // `ran` with another id left every caller to notice — the rebuild does, the
  // retrain runner does not — so the refusal is made HERE, by name.
  if (ranModelId !== input.modelId) {
    return refuse(
      deps,
      input,
      'model-not-servable',
      `the executor ran "${ranModelId}" for a call pinned to "${input.modelId}" — its output would not be comparable with the pass`,
    )
  }
  const details: DetailResult[] = result.detections.map((detection) =>
    toDetailResult(detection, input.stepId, crop),
  )
  return { kind: 'ran', nodeId: deps.nodeId, modelId: ranModelId, details }
}
