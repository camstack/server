/**
 * Turning one switch into the LIST the wake decision reads.
 *
 * The form shows a switch per signal; the store holds a list of enabled codes.
 * Two representations of one choice is the defect this repo keeps paying for —
 * so the switch does not get a flag of its own, it edits the list.
 *
 * The subtle part is the FIRST write. Absent means "every signal the camera
 * declares", which is what lets a camera work without an operator ever opening
 * the form. The moment one switch is touched, the stored list must become the
 * COMPLETE answer — the declared set minus what was just switched off — and not
 * a diff against a default that a driver update could later change under it.
 */

export interface SignalSelectionInput {
  /** Every code the CAMERA declares. */
  readonly declared: readonly string[]
  /** The stored list, or `undefined` when the operator has never chosen. */
  readonly stored: readonly string[] | undefined
  /** The switch that moved. */
  readonly code: string
  readonly enabled: boolean
}

export function nextEnabledSignals(input: SignalSelectionInput): readonly string[] {
  const base = input.stored ?? input.declared
  const set = new Set(base)
  if (input.enabled) set.add(input.code)
  else set.delete(input.code)
  // Ordered by the DECLARED order so the stored list reads the way the form
  // does, with anything unknown kept at the end rather than dropped: a code the
  // camera has stopped declaring is not ours to forget on the operator's behalf.
  const known = input.declared.filter((c) => set.has(c))
  const extra = [...set].filter((c) => !input.declared.includes(c))
  return [...known, ...extra]
}
