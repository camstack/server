/**
 * What "apply the updates in this notification" actually does, minus the I/O.
 *
 * The two decisions worth isolating from the centre:
 *
 *  - **What is still out of date.** The row froze a list; the registry knows
 *    the truth now. The button applies the INTERSECTION, in the row's order,
 *    so a package somebody already updated is skipped rather than re-installed
 *    and then reported as work done.
 *  - **What the operator is told.** Three counts that are always true —
 *    applied, already-current, failed — chosen over "n of m" arithmetic that
 *    reads as under-delivery when the missing ones were simply current. No
 *    VERSION appears in any of them: a version a notification states is one the
 *    system read back (D313), and this path reads none. The `addon.updated`
 *    notification, which does, carries them.
 */

/** One `addons.updatePackage`, as this addon is willing to hear about it. */
export type NcAddonUpdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** What one tap did. Every field is a fact about THIS run. */
export interface NcAddonUpdateReport {
  /** What the button promised — the frozen list's length. */
  readonly requested: number
  readonly applied: readonly string[]
  /** Frozen, but already current by the time the operator tapped. */
  readonly skipped: readonly string[]
  readonly failed: readonly string[]
}

/**
 * The frozen packages that STILL have an update, in the order the row listed
 * them.
 *
 * Order matters: the notification's body listed them in that order, and an
 * operator watching addons restart should see them go in the order they read.
 */
export function pendingPackages(
  frozen: readonly string[],
  updatable: readonly string[],
): readonly string[] {
  const available = new Set(updatable)
  return frozen.filter((name) => available.has(name))
}

/** Which catalog key states {@link NcAddonUpdateReport}. */
export type NcAddonUpdateSentence = 'uptodate' | 'done' | 'partial'

/**
 * `done` only when every package the button promised was applied and nothing
 * was skipped or failed — the ONE case where a single number is the whole
 * truth. Anything else states all three counts, because a sentence that hides
 * one of them is a sentence that reports work it did not do.
 */
export function addonUpdateSentence(report: NcAddonUpdateReport): NcAddonUpdateSentence {
  if (report.applied.length === 0 && report.failed.length === 0) return 'uptodate'
  if (report.applied.length === report.requested && report.failed.length === 0) return 'done'
  return 'partial'
}
