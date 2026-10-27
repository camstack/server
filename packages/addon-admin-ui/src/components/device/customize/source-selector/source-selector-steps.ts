/**
 * Phone layout for `SourceSelector` (below the `sm` / 640px breakpoint).
 * Desktop shows both columns. A phone shows one step: the device list, then
 * the values. A single pick opens the values. Members stay on the list until
 * Done, which opens the values — the host dialog's own action stays put.
 */

export type SourceSelectorStep = 'devices' | 'values'

export type SourceSelectorPickMode = 'single' | 'members'

export interface SingleStepView {
  readonly seenDevice: boolean
  readonly step: SourceSelectorStep
}

/** A single pick, including the device already chosen, opens the values. Members stay on the list. */
export function stepAfterDevicePick(mode: SourceSelectorPickMode): SourceSelectorStep {
  return mode === 'single' ? 'values' : 'devices'
}

/** Done on the member list. No pick stays on the list. */
export function stepAfterDone(pickedCount: number): SourceSelectorStep | null {
  if (pickedCount <= 0) return null
  return 'values'
}

export function stepAfterBack(): SourceSelectorStep {
  return 'devices'
}

/**
 * The first time a device is chosen, open the values (an edit dialog already
 * has one). Clearing the device returns to the list. Going back keeps the
 * device, so a later render must not jump forward again.
 */
export function reconcileSingleStep(
  hasDevice: boolean,
  view: SingleStepView,
): SingleStepView | null {
  if (!hasDevice && (view.seenDevice || view.step !== 'devices')) {
    return { seenDevice: false, step: 'devices' }
  }
  if (hasDevice && !view.seenDevice) {
    return { seenDevice: true, step: 'values' }
  }
  return null
}

/** Which column a phone shows. Desktop ignores this and shows both. */
export function phoneColumnVisible(step: SourceSelectorStep, column: SourceSelectorStep): boolean {
  return step === column
}
