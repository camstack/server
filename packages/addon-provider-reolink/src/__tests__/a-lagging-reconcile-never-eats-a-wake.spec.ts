import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  decideSleepCommit,
  HUB_SUMMARY_SLEEP_GRACE_MS,
  type SleepCommitSource,
  WAKE_HYSTERESIS_MS,
} from '../sleep-state-decision.js'

/**
 * A battery camera that WOKE must not keep being reported asleep because a
 * minutes-old reconcile spoke a second before it did (D603).
 *
 * The timeline below is not invented. It is device 3629 on the live hub,
 * 2026-09-22, `addonId: provider-reolink`:
 *
 *   06:06:15.105  battery sleep state committed  {sleeping: true, source: 'hub-summary'}
 *   06:06:16.828  ignoring sleep inference flap  {next: false, sinceLastChangeMs: 1723}
 *   06:08:41.609  battery sleep state committed  {sleeping: false, source: 'simple-event'}
 *
 * 2 min 26 s of "asleep" over an awake camera, because the periodic summary
 * stamped the same clock the anti-flap window measures against. The same
 * shape again at 06:37:41 → 06:38:50 (1 min 10 s), and seven such refusals in
 * twelve hours across the fleet — every one of them in the `→ awake`
 * direction.
 *
 * These drive the real decision function over a sequence, keeping only the
 * two pieces of state `commitSleepState` keeps. The last test pins that the
 * caller still applies the decision it is given, because a rule the caller
 * ignores is the failure mode this repo has shipped before.
 */

interface SleepMirror {
  sleeping: boolean
  lastFirstHandCommitAt: number
}

interface Attempt {
  readonly atMs: number
  readonly next: boolean
  readonly source: SleepCommitSource
}

/** Exactly what `commitSleepState` does with the decision, and nothing else. */
function apply(mirror: SleepMirror, attempt: Attempt): boolean {
  const decision = decideSleepCommit({
    current: mirror.sleeping,
    next: attempt.next,
    source: attempt.source,
    lastFirstHandCommitAt: mirror.lastFirstHandCommitAt,
    nowMs: attempt.atMs,
  })
  if (decision.kind !== 'commit') return false
  if (decision.stampFirstHand) mirror.lastFirstHandCommitAt = attempt.atMs
  mirror.sleeping = attempt.next
  return true
}

/** 06:00:00.000 on the incident clock; every offset below is from the logs. */
const T0 = 1_790_000_000_000

describe('a lagging reconcile never eats a real wake', () => {
  it('replays device 3629, 06:06 — the wake is honoured a second after the reconcile', () => {
    const mirror: SleepMirror = { sleeping: false, lastFirstHandCommitAt: T0 - 600_000 }

    // 06:06:15.105 — the parent's periodic sweep, minutes behind, says asleep.
    expect(apply(mirror, { atMs: T0 + 375_105, next: true, source: 'hub-reconcile' })).toBe(true)
    expect(mirror.sleeping).toBe(true)

    // 06:06:16.828 — 1 723 ms later the camera's own push says awake. This is
    // the line the hub logged as `ignoring sleep inference flap`.
    expect(apply(mirror, { atMs: T0 + 376_828, next: false, source: 'simple-event' })).toBe(true)
    expect(mirror.sleeping).toBe(false)
  })

  it('leaves the anti-flap clock where the last FIRST-HAND observation put it', () => {
    const firstHandAt = T0
    const mirror: SleepMirror = { sleeping: false, lastFirstHandCommitAt: firstHandAt }
    // Long enough after the first-hand awake that the grace no longer
    // protects it, so the reconcile is allowed to correct the slice.
    apply(mirror, {
      atMs: firstHandAt + HUB_SUMMARY_SLEEP_GRACE_MS + 1_000,
      next: true,
      source: 'hub-reconcile',
    })
    expect(mirror.sleeping).toBe(true)
    expect(mirror.lastFirstHandCommitAt).toBe(firstHandAt)
  })

  it('still absorbs a genuine inference flap between two first-hand events', () => {
    const mirror: SleepMirror = { sleeping: true, lastFirstHandCommitAt: 0 }
    // A first-hand awake with no prior record is always honoured.
    expect(apply(mirror, { atMs: T0, next: false, source: 'simple-event' })).toBe(true)
    // …and a socket-inference bounce back to sleeping 1 s later is not.
    expect(apply(mirror, { atMs: T0 + 1_000, next: true, source: 'simple-event' })).toBe(false)
    expect(mirror.sleeping).toBe(false)
    // An inferred awake inside the wake window after a first-hand SLEEPING
    // commit is still refused — that is the flap the window exists for.
    const awake: SleepMirror = { sleeping: false, lastFirstHandCommitAt: 0 }
    apply(awake, { atMs: T0, next: true, source: 'sleep-poll' })
    expect(awake.sleeping).toBe(true)
    expect(
      apply(awake, { atMs: T0 + WAKE_HYSTERESIS_MS - 1, next: false, source: 'sleep-poll' }),
    ).toBe(false)
    expect(
      apply(awake, { atMs: T0 + WAKE_HYSTERESIS_MS + 1, next: false, source: 'sleep-poll' }),
    ).toBe(true)
  })

  it('keeps the grace pointed at first-hand state, so a lagging sleep still loses', () => {
    const mirror: SleepMirror = { sleeping: true, lastFirstHandCommitAt: 0 }
    // A wake we drove and watched land.
    expect(apply(mirror, { atMs: T0, next: false, source: 'confirmed-wake' })).toBe(true)
    // The 60 s reconcile, still reporting the pre-wake state, must not undo it.
    expect(apply(mirror, { atMs: T0 + 60_000, next: true, source: 'hub-reconcile' })).toBe(false)
    expect(apply(mirror, { atMs: T0 + 120_000, next: true, source: 'hub-reconcile' })).toBe(false)
    // …and after the grace it recovers a genuinely stuck slice.
    expect(
      apply(mirror, {
        atMs: T0 + HUB_SUMMARY_SLEEP_GRACE_MS + 1,
        next: true,
        source: 'hub-reconcile',
      }),
    ).toBe(true)
  })

  it('a summary read taken DURING a wake we drove is first-hand and stamps', () => {
    // `wakeForStream` confirms a hub child by reading the parent's summary
    // right then. It passes `hub-summary`, not `hub-reconcile`, and it must
    // keep arming the grace — otherwise the very next periodic sweep undoes
    // the wake it just confirmed.
    const mirror: SleepMirror = { sleeping: true, lastFirstHandCommitAt: 0 }
    expect(apply(mirror, { atMs: T0, next: false, source: 'hub-summary' })).toBe(true)
    expect(mirror.lastFirstHandCommitAt).toBe(T0)
    expect(apply(mirror, { atMs: T0 + 60_000, next: true, source: 'hub-reconcile' })).toBe(false)
  })
})

describe('the caller applies the decision it is given', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

  it('stamps the first-hand clock only when the decision says to', () => {
    // The rule above is worth nothing if `commitSleepState` stamps
    // unconditionally — which is precisely the bug it replaces.
    expect(cameraSource).toContain(
      'if (decision.stampFirstHand) this.sleepStateChangedAt = Date.now()',
    )
    expect(cameraSource).not.toMatch(/this\.sleepStateChangedAt = Date\.now\(\)\s*\n\s*}\s*else/)
  })

  it('routes the parent NVR periodic sweep through the reconcile source', () => {
    expect(cameraSource).toContain("this.commitSleepState(sleeping, 'hub-reconcile')")
  })
})
