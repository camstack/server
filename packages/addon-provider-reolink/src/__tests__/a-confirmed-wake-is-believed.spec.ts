import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { decideSleepCommit } from '../sleep-state-decision.js'

/**
 * What we tell the caller, we believe ourselves.
 *
 * Measured on device 3825 (Magicam, a Home Hub child) on 2026-09-19:
 *
 * ```
 * POST battery.wakeForStream {deviceId:3825}  →  { awoke: true, durationMs: 4129 }
 * … immediately after, and again 40 s later (past WAKE_HYSTERESIS_MS):
 * debugRawRead osd/image/motion/ai/enc/mask/pir/led/…  →  15 of 16 refused,
 *   "Battery camera is asleep and the read is addressed to the camera channel"
 * ```
 *
 * The camera was awake. The only slice that answered was `battery`, and it
 * answered because it does not touch the camera at all — the parent hub
 * serves it.
 *
 * The cause is a contradiction inside `wakeForStream`. For a hub child it
 * returns `awoke: true` on `confirmed` (the channel is present and not
 * offline — "the dial wakes it on demand"), but it only commits
 * `sleeping: false` on `observedAwake`, which reads the parent's summary —
 * and that summary lags real push state by more than 75 s (measured
 * 2026-08-16, and the reason `HUB_SUMMARY_SLEEP_GRACE_MS` exists).
 * `watchHubChildAwake` then polls for 45 s, which is shorter than the lag it
 * is waiting on. So the caller is told "awake" and the mirror keeps saying
 * "asleep", and every read gate consults the mirror.
 *
 * One wake must not produce two answers.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

/**
 * And the SAME is true of `wakeIfSleeping`, the operator-demand wake behind
 * the "Refresh from camera" button and behind a settings write.
 *
 * Measured on 2026-09-19, 21:29: the button reported `awake=true` and re-read
 * 5 of 5 slices off the Baby monitor — and thirteen seconds later the broker
 * was still composing its placeholder from the sleeping branch:
 *
 *   [Baby monitor] sentry: picture composed {source=cached-snapshot reason=sleeping}
 *
 * because the placeholder reads the battery slice and nothing had moved it.
 * One wake, two answers again — the same defect as `wakeForStream`, in its
 * sibling, found by the operator noticing the tile never changed.
 */
describe('wakeIfSleeping', () => {
  const body = (() => {
    const at = source.indexOf('private async wakeIfSleeping(')
    const end = source.indexOf('\n  }\n', at)
    return source.slice(at, end)
  })()

  it('commits the mirror when it reports the camera awake', () => {
    expect(body).toContain("commitSleepState(false, 'confirmed-wake')")
  })

  it('drives the wake transition, so the snapshot and the caps follow', () => {
    // `onWakeTransition` is what re-reads the caps and warms the SNAPSHOT —
    // the tile the operator was looking at when they found this.
    expect(body).toContain('onWakeTransition')
  })
})

describe('a wake we drove and confirmed', () => {
  it('has a commit source of its own', () => {
    // Not `sleep-poll` and not `hub-summary`: this is neither an inference
    // nor the parent's lagging report. It is first-hand evidence from a wake
    // this process issued and watched.
    expect(source).toContain("'confirmed-wake'")
  })

  it('is not gated by the wake hysteresis', () => {
    // The hysteresis exists to absorb the library's socket-I/O INFERENCE
    // flapping. A wake we drove is not an inference, and gating it is what
    // strands the mirror on "asleep" while the camera is plainly up.
    //
    // Driven, not read from the source text: this used to assert that the
    // string 'confirmed-wake' appeared somewhere in the method body, which
    // an inverted condition would have passed.
    const nowMs = 1_000_000
    expect(
      decideSleepCommit({
        current: true,
        next: false,
        source: 'confirmed-wake',
        lastFirstHandCommitAt: nowMs - 1_000,
        nowMs,
      }),
    ).toEqual({ kind: 'commit', stampFirstHand: true })
  })

  it('is committed on the same branch that answers the caller awake', () => {
    // The assertion that matters: whatever makes `awoke: true` true must also
    // make the mirror say awake. Anything else reintroduces the split.
    const wake = source.slice(source.indexOf('wakeForStream: async ('))
    // `lastIndexOf`: the FIRST `awoke: true` is the early-out for a camera
    // already believed awake, where the mirror needs no correcting. The one
    // that matters is the confirmed-wake path at the end.
    const answer = wake.lastIndexOf('return { awoke: true')
    expect(answer).toBeGreaterThan(-1)
    // The commit must sit BEFORE the answer, on the same path.
    const beforeAnswer = wake.slice(0, answer)
    expect(beforeAnswer).toContain("commitSleepState(false, 'confirmed-wake')")
  })
})
