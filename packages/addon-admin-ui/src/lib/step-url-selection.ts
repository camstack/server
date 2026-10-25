/**
 * `?step=&acc=` — the step matrix's open cell, in the URL (D757).
 *
 * A link can name the exact step and accelerator ("camera 101 → Object
 * Detection on hub · NPU"); the settings panel is open exactly while `step` is
 * set, a reload keeps it, and switching does not stack history entries. A
 * `step` that names nothing opens nothing AND says so, like
 * `node-url-selection.ts` — a silent fallback would show the operator a step
 * the address bar says he is not on.
 */

export const STEP_PARAM = 'step'
export const ACCELERATOR_PARAM = 'acc'

/** Every step-matrix param — a page that changes context clears them all. */
export const STEP_INSPECTOR_PARAMS: readonly string[] = [STEP_PARAM, ACCELERATOR_PARAM]

/** `hub` + `openvino:npu` → `hub/openvino:npu` (a deviceKey carries a colon, a node id a dot). */
export function acceleratorId(nodeId: string, deviceKey: string): string {
  return `${nodeId}/${deviceKey}`
}

/** The inverse of {@link acceleratorId}; `null` for anything that is not one. */
export function parseAcceleratorId(
  id: string,
): { readonly nodeId: string; readonly deviceKey: string } | null {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  return { nodeId: id.slice(0, slash), deviceKey: id.slice(slash + 1) }
}

export interface StepSelection {
  /** The open step; `null` = the panel is closed. */
  readonly stepId: string | null
  /**
   * The clicked accelerator, or `null` for the STEP view (a row header, a
   * search hit, an accelerator the page no longer shows). Never a guess: the
   * panel is about exactly what was clicked.
   */
  readonly acceleratorId: string | null
  /** The `?step=` the page could not find, to say so. */
  readonly staleStepId: string | null
}

/** Resolve the raw params against the steps and accelerators the page shows. */
export function resolveStepSelection(
  stepIds: readonly string[],
  acceleratorIds: readonly string[],
  params: { readonly step: string | null; readonly acc: string | null },
): StepSelection {
  const stepKnown = params.step !== null && stepIds.includes(params.step)
  const accKnown = params.acc !== null && acceleratorIds.includes(params.acc)
  return {
    stepId: stepKnown ? params.step : null,
    acceleratorId: accKnown ? params.acc : null,
    // Unknown before the catalog arrives is not stale: nothing to resolve against.
    staleStepId:
      params.step !== null && params.step !== '' && !stepKnown && stepIds.length > 0
        ? params.step
        : null,
  }
}
