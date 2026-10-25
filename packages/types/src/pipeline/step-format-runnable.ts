/**
 * The ONE answer to "can a pool of `format` run this step?" (D657).
 *
 * A step can run on a format when the model it NAMES ships a build for that
 * format, or when a NON-legacy model of the step does (the format-default
 * resolution picks among those). A `legacy` build is a catalog stub kept for
 * explicit selection — the Coral face SSD has no working postprocessor — so it
 * makes a format runnable only when it is the model named.
 *
 * Every placement decision reads this: the orchestrator's provisioning gate
 * (`addonHasCompatibleModel`), the executor's dispatch gate
 * (`collectZeroBuildIssues`) and the runner's device jump
 * (`buildSubtreeCanRun`). Three rules for this question existed before; two of
 * them counted the legacy stub and one did not, so the runner jumped a face
 * step off the Coral while the executor loaded it there, and the root's load
 * failed with it.
 *
 * Lives in the bare `@camstack/types` entry, which every addon bundles
 * (`self-contained` externals), so it travels with a `camstack deploy`.
 */

/** The catalog facts one model contributes: its id, its builds, and whether it is a legacy stub. */
export interface FormatRunnableModel {
  readonly id: string
  readonly legacy?: boolean
  readonly formats: Readonly<Record<string, unknown>>
}

/** True when `model` ships a build for `format`. */
function hasBuild(model: FormatRunnableModel, format: string): boolean {
  return Boolean(model.formats[format])
}

/**
 * Can a pool of `format` run a step whose catalog is `models`, given the model
 * the step names (`null`/absent = unpinned, the format default)?
 */
export function stepModelRunsOnFormat(
  models: readonly FormatRunnableModel[],
  modelId: string | null | undefined,
  format: string,
): boolean {
  if (modelId !== undefined && modelId !== null) {
    const named = models.find((m) => m.id === modelId)
    if (named !== undefined && hasBuild(named, format)) return true
  }
  return models.some((m) => m.legacy !== true && hasBuild(m, format))
}
