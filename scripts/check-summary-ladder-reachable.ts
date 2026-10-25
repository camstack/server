#!/usr/bin/env tsx
/**
 * Summary-ladder guard — the digest's best rung must be a picture of the
 * SUBJECT, never of the whole scene.
 *
 * ## The failure this closes
 *
 * (2026-08-24 14:51) did two correct things in one commit
 * and they cancelled each other:
 *
 *  1. it rewrote `SUMMARY_MEDIA_LADDER` to
 *     `groupCrop → nativeFrame → keyFrame → keyFrameSmall → fullFrame`,
 *     dropping `thumbnail` / `thumbnailSmall` / `snapshot` because a plate read
 *     overwrites the vehicle crop under the same `thumbnail` kind — a real
 *     collision, on the GROUP entity;
 *  2. it set `GROUPS_PROCESS_ENABLED = false`, because duplicate sealed rows
 *     had made Library → Gruppi unusable.
 *
 * With the group process off, the summary port returned TRACKS, not groups, so
 * no row on the wire could ever carry `groupCrop` or `nativeFrame`. The first
 * live rung became `keyFrame` — a whole frame. Every summary notification
 * shipped a full frame instead of the subjects for three days and nothing said
 * a word: both halves reviewed as correct in isolation, and neither test suite
 * knew about the other file.
 *
 * The group entity was DELETED on 2026-09-01 (operator decision) and its two
 * rungs went with it, so there is no longer a switch that can make the head of
 * the ladder unreachable. What remains is the invariant that outlives it.
 *
 * ## What it checks
 *
 * Reads the real `SUMMARY_MEDIA_LADDER` and the real
 * `SUMMARY_SUBJECT_CROP_RUNGS` — no copies, so the guard cannot drift from
 * what production reads. Then:
 *
 *  - the ladder must be non-empty and free of duplicate rungs;
 *  - its FIRST rung — the picture every digest tile is drawn from when that
 *    media exists — must be in `SUMMARY_SUBJECT_CROP_RUNGS`.
 *
 * ## Why this and not a test
 *
 * A unit test lives inside one package and asserts the ladder that package
 * declares. The bug was a CROSS-FILE contradiction that no single test owned,
 * and both files' tests stayed green. Same posture as
 * `check-recording-trigger-fed.ts`: a declared thing must be REACHABLE, not
 * merely well-typed.
 *
 * Usage: npx tsx scripts/check-summary-ladder-reachable.ts
 */
import {
  SUMMARY_MEDIA_LADDER,
  SUMMARY_SUBJECT_CROP_RUNGS,
} from '../packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts'

export interface SummaryLadderFailure {
  readonly what: string
  readonly why: string
}

/**
 * The ladder and its rung classification, as data.
 *
 * Injected rather than imported inside the checker so the spec can replay a
 * broken shape without editing production source — and so the checker has no
 * hidden input. `main()` supplies the real constants.
 */
export interface SummaryLadderShape {
  readonly ladder: readonly string[]
  readonly subjectCropRungs: ReadonlySet<string>
}

const LADDER_PATH =
  'packages/addon-post-analysis/src/notification-center/summary/summary-selection.ts'

export function findSummaryLadderFailures(
  shape: SummaryLadderShape,
): readonly SummaryLadderFailure[] {
  const failures: SummaryLadderFailure[] = []

  if (shape.ladder.length === 0) {
    failures.push({
      what: 'SUMMARY_MEDIA_LADDER is empty',
      why: 'every track would be dropped for having no usable media',
    })
    return failures
  }

  const seen = new Set<string>()
  for (const rung of shape.ladder) {
    if (seen.has(rung)) {
      failures.push({
        what: `rung '${rung}' appears twice`,
        why: 'a duplicate rung makes the ladder order ambiguous to read and to reason about',
      })
    }
    seen.add(rung)
  }

  const best = shape.ladder[0]
  if (best !== undefined && !shape.subjectCropRungs.has(best)) {
    failures.push({
      what: `the best rung is '${best}', which is not a subject crop`,
      why:
        `That leaves '${best}' as the picture every digest tile is drawn from, and it is a ` +
        `whole frame. Put a rung from SUMMARY_SUBJECT_CROP_RUNGS ` +
        `[${[...shape.subjectCropRungs].join(', ')}] above it in ${LADDER_PATH}`,
    })
  }

  return failures
}

/** What the repo ACTUALLY declares, read from the module production reads. */
export function committedSummaryLadderShape(): SummaryLadderShape {
  return {
    ladder: SUMMARY_MEDIA_LADDER,
    subjectCropRungs: SUMMARY_SUBJECT_CROP_RUNGS,
  }
}

function main(): void {
  const shape = committedSummaryLadderShape()
  const failures = findSummaryLadderFailures(shape)
  if (failures.length === 0) {
    console.log(
      `\x1b[32m  ✔ summary ladder: best rung '${shape.ladder[0] ?? '?'}' is a subject crop ` +
        `(${shape.ladder.length} rungs)\x1b[0m`,
    )
    return
  }
  console.error(`\x1b[31m✘ ${failures.length} summary-ladder problem(s)\x1b[0m:`)
  for (const f of failures) {
    console.error(`    ${f.what}`)
    console.error(`      → ${f.why}`)
  }
  console.error(
    '    → this is 160200681 (2026-08-24): a correct ladder rewrite and a correct kill switch',
  )
  console.error(
    '      landed in the same commit and cancelled each other. Every summary notification',
  )
  console.error('      shipped a whole frame instead of the subjects for three days.')
  process.exit(1)
}

main()
