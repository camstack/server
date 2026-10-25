#!/usr/bin/env tsx
/**
 * The stillness VALVE must be reachable inside the session an on-motion camera
 * can actually give it — and it must still be the thing that ends the hold.
 *
 * ## The failure this catches
 *
 * A track that has held still across `sessionStillnessWindowMs` (30 000 ms)
 * stops counting as PRESENT, which is what lets an on-motion session close on a
 * parked car instead of running to its cap. On an `on-motion` camera that track
 * only exists while the orchestrator holds a detection session open. Nothing in
 * either package mentions the other, and the two numbers were not compatible:
 *
 *   - `SessionDispatchController`'s falling-edge branch consulted ONLY
 *     `MIN_SESSION_OPEN_MS` (10 000 ms). The hold, the freshness read and
 *     `maxSessionHoldMs` all lived inside the COOLDOWN TIMER's body, which a
 *     falling edge never entered.
 *   - Every camera in the fleet emits an explicit falling edge.
 *
 * So the longest session a real camera could reach was the FLOOR, and the
 * floor is 10 s against a 30 s stillness window. Measured on device 102 over
 * 24 h, 503 sessions: median duration 10 221 ms, 502/503 closes on
 * `motion_cleared`, the hold branch fired 0 times, `maxSessionHoldMs` fired 0
 * times, and 0 single-session tracks reached 30 s. The valve was unreachable
 * by construction.
 *
 * ## Why this guard did NOT become obsolete when promotion moved to evidence
 *
 * Birth is now decided by repetition (`stationary-evidence.ts`), not by one
 * track surviving. The 30 s test survives doing the OTHER half of its old job:
 * taking a motionless subject out of the presence signal. That half is now
 * load-bearing in a way it never was — it is the ONLY thing standing between
 * the fleet and a permanent session. Delete it and 102's 504 daily sessions
 * each run to the 120 s cap: 70% detection uptime on one camera, with 104, 103
 * and 1443 already above 50%.
 *
 * No test could see it: every piece worked correctly on its own. The defect
 * lived in the ARITHMETIC BETWEEN two packages, plus one routing decision that
 * made the arithmetic moot. That is not a thing review catches, so it gets a
 * check.
 *
 * ## What it checks
 *
 * 1. **The ceiling fits the window.** `SESSION_STILLNESS_WINDOW_MS +
 *    SESSION_WARMUP_HEADROOM_MS <= DEFAULT_MAX_SESSION_HOLD_MS`. The headroom
 *    is a MEASUREMENT: median 5.3 s elapses between a session opening and the
 *    first observation of a track on it (decode + model warm-up + the
 *    tracker's own confirmation gate), so the promotion clock does not start
 *    at the session's t=0.
 *
 * 2. **The falling edge consults the hold.** If `handleSessionMotion`'s
 *    teardown branch goes anywhere except `resolveSessionLifecycleLocked`, or
 *    if `closeActiveSessionLocked` grows a second caller that skips the rule,
 *    the reachable ceiling collapses back to `MIN_SESSION_OPEN_MS` — which
 *    check 1 cannot see, because both constants stay untouched.
 *
 * 3. **The liveness signal means PRESENT, not MOVING.** A `hasMovingTrack`
 *    gate on the tap flaps on detector jitter and cannot hold a session for a
 *    subject that merely paused. Restoring it would break the hold again with
 *    every constant still correct.
 *
 * 4. **Stillness still ENDS the hold.** The presence flag must be derived from
 *    the post-suppression `result.tracked` MINUS whatever `trackIsStill`
 *    reports as stopped. That subtraction is the valve. Without it a parked car
 *    pins every session to the cap, forever — which is a worse fault than the
 *    one the hold was introduced to fix.
 *
 * 5. **Birth does NOT come from track survival.** The evidence criterion must
 *    still be what creates an entry. A reintroduced `evaluateStationaryPromotion`
 *    would put the old, class-blind, well-seen-objects-win criterion back next
 *    to the new one — two authorities for one decision (D62).
 *
 * Not checked, because it is not a static relation: an OPERATOR who raises
 * `sessionStillnessWindowMs` per camera must also raise that camera's
 * `maxSessionHoldMs`. There is no global→device cascade to read here, and the
 * pair is satisfiable within both schemas' bounds.
 *
 * Usage: tsx scripts/check-stationary-promotion-reachable.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CONTROLLER = 'packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts'
const SUBSCRIPTIONS = 'packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts'
const STATIONARY_TYPES =
  'packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-types.ts'
const ANALYTICS = 'packages/addon-post-analysis/src/pipeline-analytics/index.ts'
const RUNNER_CAP = 'packages/types/src/capabilities/pipeline-runner.cap.ts'

/**
 * Measured lead time (ms) between a session opening and the first observation
 * of a track on it — device 102, 24 h: median 5 300 ms. Rounded up. The
 * promotion clock cannot start before this, so the cap has to cover both.
 */
const SESSION_WARMUP_HEADROOM_MS = 6_000

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

/** `export const NAME = 12_345` — numeric literal only. */
function constant(source: string, relative: string, name: string): number {
  const match = new RegExp(`export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)`).exec(
    source,
  )
  if (match === null) {
    console.error(`\x1b[31m✘ could not read \`${name}\`\x1b[0m from ${relative}`)
    console.error('    If the declaration shape changed, update this script.')
    process.exit(1)
  }
  return Number(match[1]?.replaceAll('_', ''))
}

/** `const maxSessionHoldMsField = { min: 0, max: 600_000, default: 120_000, … }` */
function capFieldDefault(source: string, field: string): number {
  const match = new RegExp(`const ${field}\\s*=\\s*\\{[^}]*?default:\\s*([\\d_]+)`).exec(source)
  if (match === null) {
    console.error(`\x1b[31m✘ could not read \`${field}.default\`\x1b[0m from ${RUNNER_CAP}`)
    process.exit(1)
  }
  return Number(match[1]?.replaceAll('_', ''))
}

/** Count non-overlapping occurrences of a literal needle. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function main(): void {
  const controller = read(CONTROLLER)
  const subscriptions = read(SUBSCRIPTIONS)
  const stationary = read(STATIONARY_TYPES)
  const analytics = read(ANALYTICS)
  const runnerCap = read(RUNNER_CAP)

  const stillnessWindowMs = constant(stationary, STATIONARY_TYPES, 'SESSION_STILLNESS_WINDOW_MS')
  const maxHoldMs = constant(controller, CONTROLLER, 'DEFAULT_MAX_SESSION_HOLD_MS')
  const minOpenMs = constant(controller, CONTROLLER, 'MIN_SESSION_OPEN_MS')
  const subjectStaleMs = constant(controller, CONTROLLER, 'SUBJECT_PRESENT_STALE_MS')
  const capDefaultMs = capFieldDefault(runnerCap, 'maxSessionHoldMsField')

  const problems: Problem[] = []

  // ── 1. the ceiling has to fit the window ────────────────────────────────
  const neededMs = stillnessWindowMs + SESSION_WARMUP_HEADROOM_MS
  if (neededMs > maxHoldMs) {
    problems.push({
      what: `SESSION_STILLNESS_WINDOW_MS (${stillnessWindowMs}) + ${SESSION_WARMUP_HEADROOM_MS}ms of measured warm-up = ${neededMs}ms, but a session can be held at most DEFAULT_MAX_SESSION_HOLD_MS (${maxHoldMs}ms)`,
      fix: 'a motionless subject would hit the cap before the valve could close the session — raise the cap or lower the stillness window',
    })
  }

  if (capDefaultMs !== maxHoldMs) {
    problems.push({
      what: `DEFAULT_MAX_SESSION_HOLD_MS (${maxHoldMs}) no longer mirrors maxSessionHoldMsField.default (${capDefaultMs})`,
      fix: `the orchestrator's fallback and the cap's own default must agree, or a camera with no stored value is held for a different time than the UI promises — reconcile ${CONTROLLER} with ${RUNNER_CAP}`,
    })
  }

  if (subjectStaleMs >= stillnessWindowMs) {
    problems.push({
      what: `SUBJECT_PRESENT_STALE_MS (${subjectStaleMs}) is not smaller than SESSION_STILLNESS_WINDOW_MS (${stillnessWindowMs})`,
      fix: 'the presence window is a tolerance for a stalled frame path, not a second stillness clock — keep it far below the window it protects',
    })
  }

  // ── 2. the falling edge must consult the hold ───────────────────────────
  if (!controller.includes("resolveSessionLifecycleLocked(deviceId, 'motion_cleared')")) {
    problems.push({
      what: `${CONTROLLER}'s falling-edge branch no longer routes through \`resolveSessionLifecycleLocked\``,
      fix: `an explicit \`detected:false\` that consults only the floor caps every real session at MIN_SESSION_OPEN_MS (${minOpenMs}ms), which is below SESSION_STILLNESS_WINDOW_MS (${stillnessWindowMs}ms) — the valve becomes unreachable again with every constant still correct`,
    })
  }

  const closeCallSites = count(controller, 'this.closeActiveSessionLocked(')
  if (closeCallSites !== 1) {
    problems.push({
      what: `\`closeActiveSessionLocked\` has ${closeCallSites} caller(s) in ${CONTROLLER}, expected exactly 1`,
      fix: 'every lifecycle close must go through the ONE rule (`resolveSessionLifecycleLocked`); a second caller is a path that skips the hold and the cap — which is exactly how this defect was introduced. A caller that legitimately bypasses the rule (an operator stop) belongs in `stopForDevice`, which detaches directly and never touches this method',
    })
  }

  if (!controller.includes('decideSessionLifecycle(')) {
    problems.push({
      what: `${CONTROLLER} no longer calls \`decideSessionLifecycle\``,
      fix: 'the hold/defer/close decision must stay one pure rule shared by every close path',
    })
  }

  // ── 3. the liveness signal must mean PRESENT ────────────────────────────
  if (!subscriptions.includes('event.data.hasLiveTrack !== true')) {
    problems.push({
      what: `${SUBSCRIPTIONS} no longer gates the session-hold tap on \`hasLiveTrack\``,
      fix: 'the tap feeds the hold; without a presence gate the hold is fed by nothing (or by the wrong thing)',
    })
  }
  // A property READ, not the name: the comment above the tap explains what the
  // old gate was and why it went, and a guard that forbade the word would
  // forbid the explanation.
  if (/\.hasMovingTrack\b/.test(subscriptions)) {
    problems.push({
      what: `${SUBSCRIPTIONS} references \`hasMovingTrack\``,
      fix: `a MOVING-only predicate cannot hold a session open for a subject that has STOPPED, and a session that closes on jitter is the fault D261 removed — that predicate is why the ${stillnessWindowMs}ms window was never once reached`,
    })
  }

  // ── 4. stillness must END the hold ──────────────────────────────────────
  // The SUBTRACTION, not just the source. `result.tracked` alone was enough
  // while a promotion dropped the parked object out of it; now that birth needs
  // minutes of repeated evidence, a motionless car stays in `result.tracked`
  // the whole time and only this predicate takes it out of the signal.
  if (!/hasLiveTrack = result\.tracked\.some\(/.test(analytics)) {
    problems.push({
      what: `${ANALYTICS} no longer derives \`hasLiveTrack\` by FILTERING \`result.tracked\``,
      fix: 'presence must come from the POST-suppression tracked set minus whatever has stopped. `result.tracked.length > 0` on its own is the permanent-session bug: a parked car is tracked continuously and would pin every session to maxSessionHoldMs',
    })
  }
  if (!/hasLiveTrack = result\.tracked\.some\([\s\S]{0,600}trackIsStill\(/.test(analytics)) {
    problems.push({
      what: 'the presence signal no longer excludes tracks that `trackIsStill` reports as stopped',
      fix: 'that exclusion IS the valve — without it a motionless parked object keeps being tracked, keeps being present, and holds every session to the maxSessionHoldMs cap forever (102: 504 sessions/24h x 120 s = 70% uptime on one camera)',
    })
  }

  // ── 5. birth must NOT come back to track survival ───────────────────────
  if (/\bevaluateStationaryPromotion\b/.test(analytics)) {
    problems.push({
      what: `${ANALYTICS} references \`evaluateStationaryPromotion\``,
      fix: 'birth is decided by repeated evidence (`stationary-evidence.ts`). A criterion anchored on ONE track surviving rewards objects seen well and often, which is why device 102 held one entry against three parked cars — the two it missed were re-discovered as 140 and 112 separate short tracks',
    })
  }
  if (!analytics.includes('birthStationaryFromEvidence')) {
    problems.push({
      what: `${ANALYTICS} no longer creates stationary entries from the evidence ledger`,
      fix: 'the evidence ledger is the ONLY producer of a stationary entry; if this call is gone, nothing is parking anything',
    })
  }

  if (problems.length > 0) {
    console.error(
      `\x1b[31m✘ ${problems.length} stationary-promotion reachability relation(s) broken\x1b[0m:`,
    )
    for (const p of problems) {
      console.error(`    ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    process.exit(1)
  }

  console.log(
    `  ✔ the stillness valve is reachable from an on-motion session: ` +
      `${stillnessWindowMs}ms window + ${SESSION_WARMUP_HEADROOM_MS}ms measured warm-up = ${neededMs}ms, ` +
      `under the ${maxHoldMs}ms cap. The falling edge consults the hold (so the ceiling is the cap, ` +
      `not the ${minOpenMs}ms floor), the hold is fed by PRESENCE with a ${subjectStaleMs}ms staleness ` +
      `window, and a track that has stopped is subtracted from that signal — which is what keeps a ` +
      `parked object from holding a session open. Birth stays on the evidence ledger. An operator ` +
      `raising sessionStillnessWindowMs per camera must raise that camera's maxSessionHoldMs too; ` +
      `that pair is not statically checkable.`,
  )
}

main()
