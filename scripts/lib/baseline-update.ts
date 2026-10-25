/**
 * baseline-update — what `check-ci-baselines --update` may write.
 *
 * The baseline is a RATCHET: a bucket may only shrink. Until 2026-10-01
 * `--update` wrote whatever it measured, upward included, so an author who
 * introduced an error and re-pinned had pinned it — "shrink-only" was a
 * convention in a comment (D695 review). Now:
 *
 *  - a count above its pin, or a key the baseline does not have, is REFUSED
 *    unless the caller names that check in `--allow-increase <check>` (the
 *    commit then carries the evidence: the flag is in the command, the diff
 *    in the file);
 *  - production `typecheck` may hold NOTHING — it is the bucket D695 holds at
 *    zero, so a non-zero entry is refused even with the flag.
 */

export interface UpdateRefusal {
  readonly bucket: string
  readonly pinned: number | null
  readonly actual: number
}

export interface UpdatePlan {
  readonly next: Readonly<Record<string, number>>
  readonly refusals: readonly UpdateRefusal[]
}

/** Checks that may never carry a pinned violation. */
export const ZERO_ONLY_CHECKS: ReadonlySet<string> = new Set(['typecheck'])

export function planBaselineUpdate(
  check: string,
  actual: ReadonlyMap<string, number>,
  pinned: Readonly<Record<string, number>>,
  allowIncrease: boolean,
): UpdatePlan {
  const refusals: UpdateRefusal[] = []
  const next: Record<string, number> = {}
  for (const bucket of [...actual.keys()].toSorted()) {
    const now = actual.get(bucket) ?? 0
    const then = Object.hasOwn(pinned, bucket) ? (pinned[bucket] ?? 0) : null
    if (ZERO_ONLY_CHECKS.has(check) && now > 0) {
      refusals.push({ bucket, pinned: then, actual: now })
      continue
    }
    if ((then === null || now > then) && !allowIncrease) {
      refusals.push({ bucket, pinned: then, actual: now })
      continue
    }
    next[bucket] = now
  }
  return { next, refusals }
}
