/**
 * resolve-step-default-model — the ONE step-model primitive every admin-ui
 * surface that shows or edits a step's model consumes. Two questions, two
 * exported answers, no local copies:
 *
 *   - which models may this step run on this device? → `stepModelOptions`
 *     (and its boolean form `stepHasModelForFormat`);
 *   - which model does it ACTUALLY run right now?    → `resolveEffectiveStepModel`
 *     (override → base → `resolveEffectiveDefaultModel`).
 *
 * Consumers: `AgentStepEditor` (the drawer picker), `NodeDeviceStepsMatrix`
 * (per-node base), the camera step inspector (read-only, D927) and the Models
 * page. They are views of the same decision and drifted
 * apart once already — see `resolveEffectiveDefaultModel` for the bite.
 * `scripts/check-step-model-single-owner.ts` is what stops the next copy.
 *
 * The rest of this file is the pure, UI-side mirror of the runner's
 * `getDefaultModelForFormat` (`@camstack/addon-pipeline`
 * `registry/step-definitions.ts`). The steps×device matrices need to show, per
 * cell, the model a STEP would actually run on a device's engine format — but
 * that resolver lives in a self-contained addon and can't be imported here, so
 * this replicates the exact same decision from the `getSchema` catalog the
 * matrix already fetches.
 *
 * Resolution order (identical to the runner):
 *   1. the step's declared per-format default (`defaultModelIdByFormat[format]`)
 *      when it has a build for `format`;
 *   2. the step's `defaultModelId` when it has a build for `format`;
 *   3. otherwise the smallest NON-legacy model that has a `format` build;
 *   4. otherwise `defaultModelId` unchanged (no compatible build — the caller
 *      renders a "⚠ skip"/N-A cell, never this value).
 *
 * This is the STEP's default — NOT the device's `defaultModelId`, which is the
 * per-device elected OBJECT-DETECTION model and is only correct for the
 * detector row. Every other step (face detection, embedding, plate OCR, …) must
 * resolve its own catalog default here.
 */

/**
 * The minimal per-step model catalog this resolver reads. `PipelineAddonSchema`
 * (from `pipelineExecutor.getSchema`) is structurally assignable to it — its
 * `formats` values carry `{ downloaded, sizeMB }`, a superset of `{ sizeMB }`.
 */
export interface StepModelCatalog {
  readonly models: readonly {
    readonly id: string
    readonly formats: Readonly<Record<string, { readonly sizeMB: number }>>
    readonly legacy?: boolean
  }[]
  readonly defaultModelId: string
  readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
}

export function resolveStepDefaultModel(catalog: StepModelCatalog, format: string): string {
  const hasFormatBuild = (modelId: string): boolean =>
    catalog.models.find((m) => m.id === modelId)?.formats[format] !== undefined

  const declared = catalog.defaultModelIdByFormat?.[format]
  if (declared !== undefined && hasFormatBuild(declared)) return declared

  if (hasFormatBuild(catalog.defaultModelId)) return catalog.defaultModelId

  // Smallest-by-size NON-legacy build wins the auto-pick (mirrors the runner:
  // a superseded tiny lineage must not silently beat the curated default).
  const available = catalog.models.filter(
    (m) => m.formats[format] !== undefined && m.legacy !== true,
  )
  if (available.length === 0) return catalog.defaultModelId

  const sorted = [...available].toSorted(
    (a, b) => (a.formats[format]?.sizeMB ?? Infinity) - (b.formats[format]?.sizeMB ?? Infinity),
  )
  return sorted[0]!.id
}

/**
 * The model a matrix CELL shows as this step's effective default on `device`.
 *
 * The device's ELECTED model (`device.defaultModelId`, the per-device
 * object-detection election) applies ONLY when this step's catalog actually
 * contains it — `slot === 'detector'` alone is too wide, because
 * package-detection shares the detector slot with the root step. Bit live
 * 2026-08-08: rfdetr-package became the package step's default and every
 * matrix cell still showed the device's yolo as the "selected" model, because
 * the election was applied slot-wide. Membership is the principled gate: an
 * elected model this step cannot run is never displayed for it.
 */
export function resolveEffectiveDefaultModel(
  catalog: StepModelCatalog & { readonly slot?: string },
  device: { readonly format?: string; readonly defaultModelId?: string } | null | undefined,
): string | undefined {
  const format = device?.format
  if (format === undefined) return undefined
  const elected = device?.defaultModelId
  const electedBelongsHere =
    catalog.slot === 'detector' &&
    elected !== undefined &&
    catalog.models.some((m) => m.id === elected)
  return electedBelongsHere ? elected : resolveStepDefaultModel(catalog, format)
}

/**
 * The minimal model shape option-derivation needs: a per-format build map.
 * `PipelineAddonSchema['models'][number]` is structurally assignable, and the
 * generic below returns the CALLER's element type so a picker still receives
 * `name` / `group` / `sizeMB`.
 */
export interface StepModelFormatBuilds {
  readonly formats: Readonly<Record<string, unknown>>
}

/**
 * The models a step may run on an engine `format` — the ONE derivation of the
 * option list. An unknown format yields NOTHING rather than everything: a
 * picker that offered a model with no build for the device would write a pin
 * the runner cannot honour.
 */
export function stepModelOptions<M extends StepModelFormatBuilds>(
  models: readonly M[],
  format: string | undefined,
): readonly M[] {
  if (format === undefined) return []
  return models.filter((m) => m.formats[format] !== undefined)
}

/** Can this step run on `format` at all? (`false` ⇒ the caller renders "⚠ skip"/"—".) */
export function stepHasModelForFormat(
  models: readonly StepModelFormatBuilds[],
  format: string | undefined,
): boolean {
  return stepModelOptions(models, format).length > 0
}

/** The one stored layer a model comes from: the accelerator's pin (D927). */
export interface EffectiveStepModelInput {
  readonly catalog: StepModelCatalog & { readonly slot?: string }
  readonly device: { readonly format?: string; readonly defaultModelId?: string } | null | undefined
  /** Per-(node,device) pin (`inferenceDevices[node][deviceKey].steps[step].modelId`). */
  readonly base?: string | undefined
}

/**
 * The model a step ACTUALLY runs on an accelerator — the whole effective chain
 * in one place: the per-(node,device) pin → the resolved default
 * (`resolveEffectiveDefaultModel`). A model is chosen by the accelerator that
 * runs it (D927); a camera has no layer here.
 *
 * Every surface calls this: the matrix cell, and the drawer's picker seed. They
 * are the same number, and the only way to keep them the same number is to have
 * one function produce it.
 */
export function resolveEffectiveStepModel(input: EffectiveStepModelInput): string | undefined {
  return input.base ?? resolveEffectiveDefaultModel(input.catalog, input.device)
}
