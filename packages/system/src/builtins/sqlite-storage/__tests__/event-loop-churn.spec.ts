/**
 * SqliteSettingsBackend writes occupy the isolate's event loop for the
 * duration of the sqlite work.
 *
 * Live hub 2026-08-24 ~19:13: hub-main's JS thread idle 16.4%, GC 12.9%,
 * native `Statement.run` up to 35% of a 20 s profile, callers
 * `sqlite-settings.addon` `set` / `tableUpdate` / `deleteWhere`. Disk was
 * idle (~170 KB/s); the thread was copying RPC and committing settings.
 * Every tRPC / UDS / Moleculer hop shares that thread ([D181]).
 *
 * This spec is the programmatic reproduction. The control proves the probe
 * can see yielding work. The sqlite burst is the disease: a fleet-shaped
 * `setDeviceRuntimeState` flush (the 1 Hz `writeDeviceRuntimeState` path)
 * produces one pause ≈ the burst. Isolating the engine is a win only when
 * a caller-side `await` of the same writes looks like the control — that
 * acceptance is `settings-door-view.spec.ts` (timer-shaped door) plus D231
 * (the production door is a UDS hop). This file pins the engine as the stall.
 *
 * Mutation: replacing the sqlite loop with `await new Promise(r =>
 * setTimeout(r, burstMs))` drops longestPause / burst below 0.4 and fails
 * the disease assertion. Neutralising the probe (no setImmediate chain)
 * makes the control fail.
 *
 * The control's window is longer than the disease's burst on purpose. The CI
 * runner is a container capped at ONE CFS core (`cpu.max 100000 100000`) on a
 * box whose other runner and CamStack agent share the same four; measured
 * 2026-09-24 it had been throttled in 55 % of its 100 ms periods, and a
 * throttled cgroup freezes EVERY thread for the rest of the period. A 40 ms
 * control window read that freeze as a 26–31 ms pause and, once, as four pings
 * — three red runs out of four — and it was grading the scheduler, not the
 * probe. The control tolerates one full period: over 400 ms the freeze is a
 * fifth of the window, and only a burst that never yields at all reaches
 * `YIELDING_PAUSE_FRACTION`. The disease burst stays at 40 ms: a sync stall
 * only looks MORE like a stall when the machine is starved (D624).
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import { measureEventLoopDuring } from './support/event-loop-probe.js'

const CAMERA_COUNT = 32
const TARGET_BURST_MS = 40
/**
 * Four CFS periods (`cpu.cfs_period_us` defaults to 100 000). A cgroup that
 * spends its quota is frozen until the period ends, so a yielding window
 * shorter than one period can be one pause, and that pause is the kernel's.
 */
const CONTROL_WINDOW_MS = 400
const MAX_ROUNDS = 512
const YIELDING_PAUSE_FRACTION = 0.4
const STALL_PAUSE_FRACTION = 0.8

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-event-loop-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  return backend
}

/**
 * Persistable cap-slice map in the shape `DeviceStateMirror` flushes: a
 * handful of slices whose clocks move every tick, so the effective-change
 * gate would not skip the write.
 */
function runtimeBlob(tick: number): Record<string, unknown> {
  const ts = 1_787_591_000_000 + tick
  return {
    'device-status': { online: true, lastChangedAt: ts, switchedOff: [] },
    'object-detection': { running: true, fps: 5, lastFrameAt: ts },
    recording: { enabled: true, mode: 'continuous', segmentMs: 10_000 },
    snapshot: { lastCapturedAt: ts, etag: `e${String(tick)}` },
    zones: {
      zones: [
        { id: 'drive', name: 'Drive', points: [0, 0, 1, 0, 1, 1, 0, 1] },
        { id: 'gate', name: 'Gate', points: [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8] },
      ],
    },
  }
}

function writeRuntimeBurst(backend: SqliteSettingsBackend, rounds: number): void {
  for (let round = 0; round < rounds; round++) {
    for (let camera = 0; camera < CAMERA_COUNT; camera++) {
      backend.setDeviceRuntimeState(String(600 + camera), runtimeBlob(round))
    }
  }
}

describe('event-loop probe', () => {
  it('sees a timer as many short pauses, not one stall', async () => {
    const measured = await measureEventLoopDuring(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, CONTROL_WINDOW_MS)
        }),
    )

    // The reading travels in the message: a red control on a shared runner has
    // to say what the machine did, or the next reader guesses.
    const reading = JSON.stringify(measured)
    expect(measured.burstMs, reading).toBeGreaterThanOrEqual(CONTROL_WINDOW_MS - 5)
    expect(measured.pingCount, reading).toBeGreaterThan(5)
    expect(measured.longestPauseMs, reading).toBeLessThan(
      measured.burstMs * YIELDING_PAUSE_FRACTION,
    )
  })

  it('and the fraction is a real bar — a sync stall inside the same window fails it', async () => {
    /**
     * Added 2026-09-24 because loosening `YIELDING_PAUSE_FRACTION` from 0.4 to
     * 0.9 left the suite GREEN. The control above only ever measures a healthy
     * timer, whose longest pause here is under half a millisecond — so ANY
     * fraction between "a hair" and 1.0 passes it, and the constant was pinned
     * by nothing. That is the shape this repo keeps finding: a threshold whose
     * value no test can be failing on.
     *
     * So the bar is exercised from the other side: a synchronous stall must
     * FAIL the same comparison a yielding timer passes.
     *
     * **What this does and does not pin, measured rather than claimed.** The
     * control gives `longestPause ≈ 0.5 ms` in a 400 ms window, so it needs
     * `F > 0.00125`. This test gives `≈ 250 ms` of a `≈ 255 ms` burst, so it
     * needs `F ≤ 0.98`. Together they pin the fraction to `(0.00125, 0.98]` —
     * which contains 0.05, 0.4 and 0.9 alike. **Disarming the constant to
     * either 0.05 or 0.9 still leaves both tests green, and I checked.**
     *
     * That is not a hole to be closed by narrowing the gap. Pinning 0.4 to a
     * digit would require both measurements to sit close to it, and on a
     * runner frozen in 55 % of its CFS periods those numbers are not the
     * test's to predict — it would trade a real property for a flaky one.
     * 0.4 is a ROBUSTNESS choice; what is testable is the DIRECTION, and
     * before this test nothing asserted that a synchronous stall is caught by
     * this bar at all.
     *
     * Deliberately not asserting an absolute millisecond count, for the same
     * reason: the claim is a RATIO, and a freeze inflates both sides of it.
     */
    const STALL_MS = CONTROL_WINDOW_MS * 0.625
    const measured = await measureEventLoopDuring(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            const until = Date.now() + STALL_MS
            while (Date.now() < until) {
              // A real synchronous stall: the loop cannot ping through it.
            }
            resolve()
          }, 5)
        }),
    )
    const reading = JSON.stringify(measured)
    expect(measured.longestPauseMs, reading).toBeGreaterThanOrEqual(
      measured.burstMs * YIELDING_PAUSE_FRACTION,
    )
  })
})

describe('SqliteSettingsBackend occupies the event loop', () => {
  it('a fleet runtime-state flush pauses the loop for the burst', async () => {
    const backend = await openBackend()
    let rounds = 4
    let measured = await measureEventLoopDuring(() => {
      writeRuntimeBurst(backend, rounds)
    })
    while (measured.burstMs < TARGET_BURST_MS && rounds < MAX_ROUNDS) {
      rounds *= 2
      measured = await measureEventLoopDuring(() => {
        writeRuntimeBurst(backend, rounds)
      })
    }

    expect(measured.burstMs).toBeGreaterThanOrEqual(TARGET_BURST_MS)
    expect(measured.pingCount).toBe(0)
    expect(measured.longestPauseMs).toBeGreaterThan(measured.burstMs * STALL_PAUSE_FRACTION)
    await backend.shutdown()
  })
})
