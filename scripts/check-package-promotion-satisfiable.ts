#!/usr/bin/env tsx
/**
 * A promotion criterion fed by the motion-settle governor must be SATISFIABLE
 * at the governor's cadence.
 *
 * ## The failure this catches
 *
 * `package-detection` is a root step the `MotionSettleGovernor` drops from the
 * dispatched tree on most frames: it runs on a motion-settle edge or, worst
 * case, on a `pollIntervalMs` safety poll (45s). Downstream, a package became a
 * delivery only once the GENERIC stationary registry promoted it — and that
 * registry required 4 recorded positions inside a 30 000 ms window, i.e. one
 * position every 10s.
 *
 * One position per 45s cannot produce four inside 30s. Not "rarely" — never.
 * `PackageDropDetector` therefore did not fire once in its entire life (zero
 * `pa-pkg-*` rows on every camera, ever, verified against the live hub on
 * 2026-08-13) while every individual component looked correct in review: the
 * step ran, the boxes were emitted, the zone rule existed, the detector was
 * wired. The defect lived only in the ARITHMETIC BETWEEN two files that never
 * mention each other.
 *
 * That is not a thing review catches, so it gets a check.
 *
 * ## What it checks
 *
 * The dedicated path (`PackageStillnessTracker`) counts FRAMES (hits), not
 * positions-in-a-window. A settle burst of three frames ~400 ms apart is three
 * hits. The constants still have to hold a relation with the governor's poll
 * for the SAFETY-NET path (a camera that only ever sees the package on the
 * 45 s poll):
 *
 *  1. `PACKAGE_STILLNESS_ROUND_GAP_MS <= pollIntervalMs`
 *     — pickup slack, not promotion. A gap wider than the poll would make a
 *       poll-spaced disappearance un-witnessable.
 *  2. `PACKAGE_STILLNESS_TTL_MS >= 4 × pollIntervalMs`
 *     — a candidate that expires between two governor rounds can never be
 *       re-associated. The factor is 4 because the MEASURED inter-round gap
 *       on device 101 was ~2 minutes, not the nominal 45s.
 *  3. `PACKAGE_STILLNESS_MIN_HITS >= 2` and
 *     `(MIN_HITS - 1) × pollIntervalMs < PACKAGE_STILLNESS_TTL_MS`
 *     — one frame is a flicker; the poll-only path must still complete
 *       inside a candidate's life.
 *  4. `packageDropDwellSec` default must not exceed the burst SPAN
 *     — if an operator leaves the default, the burst (or a single settle
 *       session, when dwell is 0) must be able to promote without waiting
 *       for the poll. Device 101 2026-08-24 13:40 missed a real parcel
 *       because dwell was 15 s and two frames 1.2 s apart counted as one
 *       round.
 *
 * One governor LOOK is one hit on the package path (raw-box sightings, not
 * tracker minHits). The settle burst must contain enough looks to reach
 * `packageDropMinFrames` / {@link PACKAGE_STILLNESS_MIN_HITS}; the poll-only
 * path is still `(minHits - 1) × pollIntervalMs < TTL`.
 *
 * And two regression checks, because the fix is only a fix while the package
 * path stays off the generic criterion:
 *
 *  5. `package-stillness-tracker.ts` must not import the generic criterion.
 *     The 4-in-30s arithmetic is gone (birth is now repetition — see
 *     `stationary-evidence.ts`), so the ORIGINAL reason for a dedicated path is
 *     gone with it. Check 6 is the reason it still has one.
 *  6. the generic evidence loop in `pipeline-analytics/index.ts` must still
 *     skip the package classes (`packageClasses.has(...)`), or one parcel
 *     produces two entries and delivers twice. This is now the LOAD-BEARING
 *     half of this guard.
 *
 * Usage: tsx scripts/check-package-promotion-satisfiable.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GOVERNOR = 'packages/addon-pipeline/src/pipeline-runner/motion-settle-governor.ts'
const TRACKER =
  'packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts'
const STATIONARY_TYPES =
  'packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-types.ts'
const ANALYTICS = 'packages/addon-post-analysis/src/pipeline-analytics/index.ts'
const PACKAGE_SETTINGS = 'packages/addon-post-analysis/src/pipeline-analytics/package-settings.ts'

/** How many governor polls a candidate must be able to sit through. */
const TTL_SAFETY_FACTOR = 4

/** Identifiers that would put the package path back on the generic criterion. */
const GENERIC_CRITERION_SYMBOLS = [
  'SESSION_STILLNESS_WINDOW_MS',
  'SESSION_STILLNESS_MIN_POINTS',
  'trackIsStill',
  'StationaryEvidenceLedger',
  'evaluateStationaryEvidence',
] as const

interface Problem {
  readonly what: string
  readonly fix: string
}

function read(relative: string): string {
  const full = path.join(ROOT, relative)
  if (!fs.existsSync(full)) {
    console.error(`\x1b[31m✘ missing file\x1b[0m: ${relative}`)
    console.error('    The guard cannot verify the relation; update this script if it moved.')
    process.exit(1)
  }
  return fs.readFileSync(full, 'utf8')
}

/** `export const NAME = 12_345` / `= 5 * 60_000` — numeric literals only, with
 *  a single optional `*` product (the file's own style). */
function constant(source: string, relative: string, name: string): number {
  const match = new RegExp(
    `export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)(?:\\s*\\*\\s*([\\d_]+))?`,
  ).exec(source)
  if (match === null) {
    console.error(`\x1b[31m✘ could not read \`${name}\`\x1b[0m from ${relative}`)
    console.error('    If the declaration shape changed, update this script.')
    process.exit(1)
  }
  const left = Number(match[1]?.replaceAll('_', ''))
  const right = match[2] === undefined ? 1 : Number(match[2].replaceAll('_', ''))
  return left * right
}

/** A numeric field of `DEFAULT_MOTION_SETTLE_CONFIG`. */
function governorField(source: string, field: string): number {
  const match = new RegExp(`DEFAULT_MOTION_SETTLE_CONFIG[\\s\\S]*?\\b${field}:\\s*([\\d_]+)`).exec(
    source,
  )
  if (match === null) {
    console.error(`\x1b[31m✘ could not read \`${field}\`\x1b[0m from ${GOVERNOR}`)
    process.exit(1)
  }
  return Number(match[1]?.replaceAll('_', ''))
}

/** `key: z.number()…default(N)` — read from its own schema rather than restated. */
function schemaDefault(source: string, key: string): number {
  const match = new RegExp(`${key}:[\\s\\S]{0,200}?\\.default\\((\\d+)\\)`).exec(source)
  if (match === null) {
    console.error(`\x1b[31m✘ could not read \`${key}\` default\x1b[0m`)
    process.exit(1)
  }
  return Number(match[1])
}

function main(): void {
  const governor = read(GOVERNOR)
  const tracker = read(TRACKER)
  const stationary = read(STATIONARY_TYPES)
  const analytics = read(ANALYTICS)
  const settings = read(PACKAGE_SETTINGS)

  const pollMs = governorField(governor, 'pollIntervalMs')
  const burstCount = governorField(governor, 'burstCount')
  const burstIntervalMs = governorField(governor, 'burstIntervalMs')
  const dwellMs = schemaDefault(settings, 'packageDropDwellSec') * 1000
  const minHitsSetting = schemaDefault(settings, 'packageDropMinFrames')
  const minHits = constant(tracker, TRACKER, 'PACKAGE_STILLNESS_MIN_HITS')
  const roundGapMs = constant(tracker, TRACKER, 'PACKAGE_STILLNESS_ROUND_GAP_MS')
  const ttlMs = constant(tracker, TRACKER, 'PACKAGE_STILLNESS_TTL_MS')
  const windowMs = constant(stationary, STATIONARY_TYPES, 'SESSION_STILLNESS_WINDOW_MS')
  const minPoints = constant(stationary, STATIONARY_TYPES, 'SESSION_STILLNESS_MIN_POINTS')

  const problems: Problem[] = []

  if (roundGapMs > pollMs) {
    problems.push({
      what: `PACKAGE_STILLNESS_ROUND_GAP_MS (${roundGapMs}) > the governor poll (${pollMs})`,
      fix: 'pickup slack wider than the poll would make a poll-spaced disappearance un-witnessable — lower the gap or lower pollIntervalMs',
    })
  }

  if (ttlMs < TTL_SAFETY_FACTOR * pollMs) {
    problems.push({
      what: `PACKAGE_STILLNESS_TTL_MS (${ttlMs}) < ${TTL_SAFETY_FACTOR} × the governor poll (${TTL_SAFETY_FACTOR * pollMs})`,
      fix: 'a candidate would expire between two governor rounds and could never be re-associated — raise the TTL or lower pollIntervalMs',
    })
  }

  if (minHits < 2) {
    problems.push({
      what: `PACKAGE_STILLNESS_MIN_HITS (${minHits}) < 2`,
      fix: "a single sighting is not stillness — one frame of a passer-by's bag would deliver",
    })
  }

  if (minHitsSetting < 2) {
    problems.push({
      what: `packageDropMinFrames default (${minHitsSetting}) < 2`,
      fix: 'the operator default must not be a single-frame flicker',
    })
  }

  const worstCaseMs = (minHits - 1) * pollMs
  if (worstCaseMs >= ttlMs) {
    problems.push({
      what: `promotion needs ${worstCaseMs}ms at poll cadence but a candidate only lives ${ttlMs}ms`,
      fix: 'lower PACKAGE_STILLNESS_MIN_HITS or raise PACKAGE_STILLNESS_TTL_MS',
    })
  }

  const burstSpanMs = (burstCount - 1) * burstIntervalMs
  if (burstSpanMs < dwellMs) {
    problems.push({
      what: `the burst spans ${burstSpanMs}ms but packageDropDwellSec is ${dwellMs}ms`,
      fix: 'the burst would end BEFORE the parcel has been still long enough to count, so the delivery would fall back to the poll — add burst runs or lower the dwell default',
    })
  }

  if (burstCount < minHitsSetting) {
    problems.push({
      what: `burstCount (${burstCount}) < packageDropMinFrames default (${minHitsSetting})`,
      fix: 'one governor burst cannot supply enough looks to promote at the default min-frames bar — raise burstCount or lower packageDropMinFrames',
    })
  }

  if (burstCount < minHits) {
    problems.push({
      what: `burstCount (${burstCount}) < PACKAGE_STILLNESS_MIN_HITS (${minHits})`,
      fix: 'one governor burst cannot supply enough looks to promote at PACKAGE_STILLNESS_MIN_HITS — raise burstCount or lower the constant',
    })
  }

  for (const symbol of GENERIC_CRITERION_SYMBOLS) {
    if (!tracker.includes(`${symbol}`) || tracker.includes(`{@link ${symbol}}`)) continue
    // Prose mentions are fine; an IMPORT is not.
    if (new RegExp(`import[\\s\\S]{0,200}\\b${symbol}\\b[\\s\\S]{0,200}from`).test(tracker)) {
      problems.push({
        what: `${TRACKER} imports \`${symbol}\``,
        fix: 'the dedicated path owns its own criterion; sharing the generic one is how one parcel ends up with two entry ids',
      })
    }
  }

  // The FULL statement, not the substring: `input.packageClasses.has(...)`
  // inside the dedicated path also contains it, and matching that would make
  // this check pass with the generic dedup guard deleted (it did, once).
  if (!/\bif \(packageClasses\.has\(t\.className\)\) continue\b/.test(analytics)) {
    problems.push({
      what: 'the generic evidence loop no longer skips the package classes',
      fix: `restore the \`if (packageClasses.has(t.className)) continue\` guard in ${ANALYTICS}, or one parcel promotes on BOTH paths and delivers twice under two entry ids`,
    })
  }

  if (problems.length > 0) {
    console.error(
      `\x1b[31m✘ ${problems.length} governor/promotion relation(s) broken\x1b[0m (poll = ${pollMs}ms):`,
    )
    for (const p of problems) {
      console.error(`    ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    process.exit(1)
  }

  const genericSpacingMs = windowMs / (minPoints - 1)
  console.log(
    `  ✔ package promotion is satisfiable on BOTH paths: ${minHits} hits ` +
      `(settings default ${minHitsSetting}) with dwell ${dwellMs}ms, ` +
      `the settle burst (${burstCount} runs ${burstIntervalMs}ms apart, span ${burstSpanMs}ms), ` +
      `and the ${pollMs}ms safety poll, with a ${ttlMs}ms candidate life ` +
      `(pickup slack ${roundGapMs}ms). The generic STILLNESS window would need one position ` +
      `every ${genericSpacingMs}ms — the arithmetic that forced this path in the first place. ` +
      `Birth is now repetition, which this cadence could satisfy; what keeps the path dedicated ` +
      `is the class skip in the generic loop, so one parcel never delivers twice.`,
  )
}

main()
