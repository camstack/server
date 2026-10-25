import { describe, expect, it } from 'vitest'
import {
  RecordingStallMonitor,
  RECORDING_DEGRADED_COOLDOWN_MS,
  RECORDING_STALL_THRESHOLD_MS,
} from '../recording-stall-monitor.js'

describe('RecordingStallMonitor', () => {
  it('fires stall once when expected and silent past the threshold', () => {
    const m = new RecordingStallMonitor()
    m.setExpected(101, true, 0)
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS - 1)).toEqual([])
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS)).toEqual([
      {
        deviceId: 101,
        idleMs: RECORDING_STALL_THRESHOLD_MS,
        thresholdMs: RECORDING_STALL_THRESHOLD_MS,
      },
    ])
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS + 60_000)).toEqual([])
  })

  it('events mode: a new event window after a long intentional idle is not a stall', () => {
    const m = new RecordingStallMonitor()
    const T = RECORDING_STALL_THRESHOLD_MS
    m.setExpected(1439, true, 0)
    m.noteSegment(1439, 1_000)
    m.setExpected(1439, false, 2_000)
    // post-buffer closed; idle far beyond the threshold, then the next trigger
    m.setExpected(1439, true, 2_000 + 3 * T)
    expect(m.sweep(2_000 + 3 * T + 1_000)).toEqual([])
  })

  it('events mode: after the restarted clock, silence past the threshold still reports', () => {
    const m = new RecordingStallMonitor()
    const T = RECORDING_STALL_THRESHOLD_MS
    m.setExpected(1439, true, 0)
    m.noteSegment(1439, 1_000)
    m.setExpected(1439, false, 2_000)
    const reopened = 2_000 + 3 * T
    m.setExpected(1439, true, reopened)
    expect(m.sweep(reopened + T)).toEqual([{ deviceId: 1439, idleMs: T, thresholdMs: T }])
  })

  it('a stall reported before the off period does not pair with a healthy after the next window opens', () => {
    const m = new RecordingStallMonitor()
    const T = RECORDING_STALL_THRESHOLD_MS
    m.setExpected(1439, true, 0)
    expect(m.sweep(T)).toHaveLength(1)
    m.setExpected(1439, false, T + 1)
    m.setExpected(1439, true, 5 * T)
    expect(m.noteSegment(1439, 5 * T + 2_000)).toBeNull()
  })

  it('a continuous camera that stays expected is still reported after the threshold', () => {
    const m = new RecordingStallMonitor()
    m.setExpected(101, true, 0)
    m.setExpected(101, true, RECORDING_STALL_THRESHOLD_MS - 10) // repeated evaluate, no edge
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS)).toHaveLength(1)
  })

  it('stays silent when recording is not expected (switched off)', () => {
    const m = new RecordingStallMonitor()
    m.setExpected(101, true, 0)
    m.setExpected(101, false, 1_000)
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS + 10_000)).toEqual([])
  })

  it('emits healthy on the first segment after a reported stall', () => {
    const m = new RecordingStallMonitor()
    m.setExpected(101, true, 0)
    expect(m.sweep(RECORDING_STALL_THRESHOLD_MS)).toHaveLength(1)
    expect(m.noteSegment(101, RECORDING_STALL_THRESHOLD_MS + 1)).toEqual({ deviceId: 101 })
    expect(m.noteSegment(101, RECORDING_STALL_THRESHOLD_MS + 2)).toBeNull()
  })

  it('cooldowns degraded notifications per camera', () => {
    const m = new RecordingStallMonitor()
    expect(m.noteDegraded(101, 'budget', 0)).toEqual({ deviceId: 101, message: 'budget' })
    expect(m.noteDegraded(101, 'budget', RECORDING_DEGRADED_COOLDOWN_MS - 1)).toBeNull()
    expect(m.noteDegraded(101, 'budget', RECORDING_DEGRADED_COOLDOWN_MS)).toEqual({
      deviceId: 101,
      message: 'budget',
    })
    expect(m.noteDegraded(104, 'other', 0)).toEqual({ deviceId: 104, message: 'other' })
  })
})
