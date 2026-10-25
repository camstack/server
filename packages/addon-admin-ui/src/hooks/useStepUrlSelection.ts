/**
 * The step matrix's `?step=&acc=`, bound to the address bar.
 *
 * Pure resolution in `lib/step-url-selection.ts`; this is the router binding:
 * `replace: true` (opening a cell must not stack history entries), and every
 * OTHER param survives (`?tab=&sub=` on the device page, `?node=&ntab=` on the
 * Pipeline page).
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ACCELERATOR_PARAM,
  resolveStepSelection,
  STEP_PARAM,
  type StepSelection,
} from '../lib/step-url-selection'

export interface StepUrlSelection {
  readonly selection: StepSelection
  /** Open (or move) the panel: a step on one accelerator, or the step alone. */
  readonly open: (next: { readonly stepId: string; readonly acceleratorId?: string }) => void
  /** Close the panel. */
  readonly close: () => void
}

export function useStepUrlSelection(
  stepIds: readonly string[],
  acceleratorIds: readonly string[],
): StepUrlSelection {
  const [params, setParams] = useSearchParams()
  const step = params.get(STEP_PARAM)
  const acc = params.get(ACCELERATOR_PARAM)
  const selection = useMemo(
    () => resolveStepSelection(stepIds, acceleratorIds, { step, acc }),
    [stepIds, acceleratorIds, step, acc],
  )
  const patch = useCallback(
    (apply: (out: URLSearchParams) => void) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev)
          apply(out)
          return out
        },
        { replace: true },
      )
    },
    [setParams],
  )
  const open = useCallback<StepUrlSelection['open']>(
    (next) =>
      patch((out) => {
        out.set(STEP_PARAM, next.stepId)
        // No accelerator = the step view: a stale `acc` must not survive it.
        if (next.acceleratorId !== undefined) out.set(ACCELERATOR_PARAM, next.acceleratorId)
        else out.delete(ACCELERATOR_PARAM)
      }),
    [patch],
  )
  const close = useCallback(
    () =>
      patch((out) => {
        out.delete(STEP_PARAM)
        out.delete(ACCELERATOR_PARAM)
      }),
    [patch],
  )
  return { selection, open, close }
}
