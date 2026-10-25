import { describe, expect, it } from 'vitest'
import {
  type CheckpointObservation,
  framesAppendedBetween,
  isWorkerMessage,
  nextCheckpointPlan,
  WAL_CHECKPOINT_LARGE_PASS_FRAMES,
  WAL_CHECKPOINT_MAX_DELAY_MS,
  WAL_CHECKPOINT_POLL_MS,
  WAL_CHECKPOINT_THRESHOLD_FRAMES,
  workerStartObservation,
} from '../wal-checkpoint-policy.js'
import { SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES } from '../sqlite-pragmas.js'

/**
 * The checkpoint worker's schedule, pure. What it must reproduce is the
 * auto-checkpoint's own rule — "at 1000 frames" — so moving the checkpoint
 * off the settings thread (D452) changes WHO pays the fsync and not how
 * often the disk is asked for one. What it must NOT do is learn the pending
 * count by reading the `-shm` file (D679): it learns it from the answers of
 * the checkpoints it already ran.
 */

const obs = (at: number, walFrames: number, checkpointedFrames: number): CheckpointObservation => ({
  at,
  walFrames,
  checkpointedFrames,
})

const plan = (previous: CheckpointObservation, current: CheckpointObservation) =>
  nextCheckpointPlan({
    previous,
    current,
    minDelayMs: WAL_CHECKPOINT_POLL_MS,
    maxDelayMs: WAL_CHECKPOINT_MAX_DELAY_MS,
  })

describe('framesAppendedBetween', () => {
  it('after a COMPLETE checkpoint the WAL restarts, so every frame in it is new', () => {
    expect(framesAppendedBetween(obs(0, 1200, 1200), obs(5_000, 300, 300))).toBe(300)
  })

  it('after an INCOMPLETE one the WAL kept growing: the difference is what was added', () => {
    expect(framesAppendedBetween(obs(0, 1200, 800), obs(5_000, 1500, 1500))).toBe(300)
  })

  it('a WAL that shrank can only have restarted: all of it is new', () => {
    expect(framesAppendedBetween(obs(0, 1200, 800), obs(5_000, 100, 100))).toBe(100)
  })

  it('reads a non-WAL answer (-1) as nothing', () => {
    expect(framesAppendedBetween(obs(0, -1, -1), obs(5_000, -1, -1))).toBe(0)
  })
})

describe('nextCheckpointPlan', () => {
  it('schedules the next checkpoint for when 1000 more frames will be pending', () => {
    // 500 frames in 4 s = 125 frames/s → 1000 frames in 8 s.
    expect(plan(obs(0, 700, 700), obs(4_000, 500, 500))).toEqual({
      appendedFrames: 500,
      nextDelayMs: 8_000,
    })
    // 1000 frames in 4 s = 250 frames/s → the threshold in 4 s.
    expect(plan(obs(0, 800, 800), obs(4_000, 1000, 1000))).toEqual({
      appendedFrames: 1000,
      nextDelayMs: 4_000,
    })
    // 100 frames in 10 s = 10 frames/s → 100 s, clamped to the max.
    expect(plan(obs(0, 200, 200), obs(10_000, 100, 100)).nextDelayMs).toBe(
      WAL_CHECKPOINT_MAX_DELAY_MS,
    )
  })

  it('never faster than the poll interval, however hot the burst', () => {
    expect(plan(obs(0, 10, 10), obs(1_000, 9_000, 9_000)).nextDelayMs).toBe(WAL_CHECKPOINT_POLL_MS)
  })

  it('never slower than the max delay — the bound on how late a burst is seen', () => {
    expect(plan(obs(0, 3, 3), obs(10_000, 1, 1)).nextDelayMs).toBe(WAL_CHECKPOINT_MAX_DELAY_MS)
    expect(plan(obs(0, 3, 3), obs(10_000, 0, 0))).toEqual({
      appendedFrames: 0,
      nextDelayMs: WAL_CHECKPOINT_MAX_DELAY_MS,
    })
  })

  it('an idle, fully checkpointed WAL is 0 appended and backs off to the max gap', () => {
    // The WAL restarts only at the next write: with no writes, every PASSIVE
    // answers the same complete `log == checkpointed`. Measured before this
    // rule: a 9 125-frame idle WAL was counted as 9 125 new frames on every
    // pass and scheduled at 1 Hz, forever (D679 review M1).
    const idle = obs(0, 9_125, 9_125)
    expect(plan(idle, obs(1_000, 9_125, 9_125))).toEqual({
      appendedFrames: 0,
      nextDelayMs: WAL_CHECKPOINT_MAX_DELAY_MS,
    })
    // An incomplete WAL that did not move is 0 appended by the plain difference.
    expect(plan(obs(0, 900, 400), obs(8_000, 900, 900)).appendedFrames).toBe(0)
  })

  it('the first checkpoint is measured from the worker’s start, as if the WAL was empty then', () => {
    // 400 frames found 2 s after start → 200 frames/s → the next in 5 s.
    expect(plan(workerStartObservation(0), obs(2_000, 400, 400))).toEqual({
      appendedFrames: 400,
      nextDelayMs: 5_000,
    })
  })

  it('a burst at the design rate cannot reach the engine fallback inside one max gap', () => {
    // 1 000 frames/s (~18× the steady 54) for a whole gap stays under the
    // 10 000-frame bound at which the ENGINE folds inside a settings commit.
    const designFramesPerSecond = 1_000
    expect((designFramesPerSecond * WAL_CHECKPOINT_MAX_DELAY_MS) / 1000).toBeLessThan(
      SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES,
    )
    // And a pass that found half the bound is what gets reported.
    expect(WAL_CHECKPOINT_LARGE_PASS_FRAMES * 2).toBe(SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES)
  })

  it('at the steady hub rate the gap is the clamp — the stated fsync cost against D452', () => {
    // D452: at 54 frames/s the threshold refilled every ~18.5 s. The clamp
    // folds every 8 s instead: ~2.3× the fsync pairs, paid on the worker.
    const rate = 54 / 1000
    const gap = plan(obs(0, 0, 0), obs(10_000, Math.round(rate * 10_000), 540)).nextDelayMs
    expect(gap).toBe(WAL_CHECKPOINT_MAX_DELAY_MS)
    expect(
      Math.round((WAL_CHECKPOINT_THRESHOLD_FRAMES / rate / WAL_CHECKPOINT_MAX_DELAY_MS) * 10) / 10,
    ).toBe(2.3)
  })

  it('the threshold is the engine default, stated once', () => {
    expect(WAL_CHECKPOINT_THRESHOLD_FRAMES).toBe(1000)
  })
})

describe('isWorkerMessage', () => {
  const report = {
    kind: 'checkpointed',
    reason: 'scheduled',
    appendedFrames: 12,
    nextDelayMs: 1_000,
    walFrames: 12,
    checkpointedFrames: 12,
    busy: false,
    ms: 3,
  }

  it('accepts a checkpoint report', () => {
    expect(isWorkerMessage(report)).toBe(true)
    expect(isWorkerMessage({ ...report, reason: 'first' })).toBe(true)
    expect(isWorkerMessage({ ...report, appendedFrames: null })).toBe(false)
  })

  it('refuses a report from the retired header-reading worker', () => {
    expect(isWorkerMessage({ ...report, reason: 'threshold' })).toBe(false)
    const { nextDelayMs: _drop, ...noDelay } = report
    expect(isWorkerMessage(noDelay)).toBe(false)
  })
})
