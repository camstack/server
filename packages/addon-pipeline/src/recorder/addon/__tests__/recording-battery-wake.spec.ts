/**
 * The recorder wakes a battery camera at the trigger (audit 2026-08-20,
 * defect 3).
 *
 * Camera 3629: **48.9 % of its episodes recorded zero footage**. A battery
 * camera is asleep between events, so the broker has no source to hand out and
 * the recorder's attach fails or returns a placeholder — while every OTHER
 * demand consumer in this system already wakes it (the live/WebRTC path does,
 * via `battery.wakeForStream`, D173). The recorder was the one consumer that
 * pulled on a sleeping camera and reported nothing.
 *
 * A recording trigger IS demand — the same class as a viewer pressing play —
 * so it takes the demand path, which bypasses the provider's proactive-wake
 * cooldown while still stamping it. What it must NOT do is re-derive the
 * presence rules: `deriveBatteryPresence` is the one derivation (D52), and an
 * `unreachable` camera is refused rather than woken (D173).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  type RecordingWakeDeps,
  wakeForRecording,
  WAKE_FOR_RECORDING_TIMEOUT_MS,
} from '../battery-wake.js'

const NOW = new Date('2026-08-20T10:00:00Z').getTime()

function deps(overrides: Partial<RecordingWakeDeps>): RecordingWakeDeps {
  return {
    isBatteryDevice: async () => true,
    readBatteryFacts: async () => ({ sleeping: true, lastContactAt: NOW - 60_000 }),
    wakeForStream: async () => ({ awoke: true, durationMs: 2_400 }),
    nowMs: () => NOW,
    ...overrides,
  }
}

describe('wakeForRecording', () => {
  it('wakes a SLEEPING battery camera — the 3629 case', async () => {
    const wakeForStream = vi.fn(async () => ({ awoke: true, durationMs: 2_400 }))
    const result = await wakeForRecording(3629, deps({ wakeForStream }))

    expect(result.outcome).toBe('woken')
    expect(result.durationMs).toBe(2_400)
    expect(wakeForStream).toHaveBeenCalledWith(3629, WAKE_FOR_RECORDING_TIMEOUT_MS)
  })

  it('does not touch a camera that is not battery-operated', async () => {
    const wakeForStream = vi.fn(async () => ({ awoke: true, durationMs: 0 }))
    const result = await wakeForRecording(
      101,
      deps({ isBatteryDevice: async () => false, wakeForStream }),
    )

    expect(result.outcome).toBe('not-battery')
    expect(wakeForStream).not.toHaveBeenCalled()
  })

  it('never wakes on an UNKNOWN battery verdict — absence of evidence is not evidence (D49)', async () => {
    const wakeForStream = vi.fn(async () => ({ awoke: true, durationMs: 0 }))
    const result = await wakeForRecording(
      101,
      deps({ isBatteryDevice: async () => null, wakeForStream }),
    )

    expect(result.outcome).toBe('unknown')
    expect(wakeForStream).not.toHaveBeenCalled()
  })

  it('does not wake a battery camera that is already awake', async () => {
    const wakeForStream = vi.fn(async () => ({ awoke: true, durationMs: 0 }))
    const result = await wakeForRecording(3629, {
      ...deps({ wakeForStream }),
      readBatteryFacts: async () => ({ sleeping: false, lastContactAt: NOW - 1_000 }),
    })

    expect(result.outcome).toBe('already-awake')
    expect(wakeForStream).not.toHaveBeenCalled()
  })

  it('REFUSES an unreachable camera rather than waking it (D173)', async () => {
    const wakeForStream = vi.fn(async () => ({ awoke: true, durationMs: 0 }))
    const result = await wakeForRecording(3629, {
      ...deps({ wakeForStream }),
      // Silent for well past the 6 h budget: this is a fault, not a nap.
      readBatteryFacts: async () => ({ sleeping: true, lastContactAt: NOW - 8 * 60 * 60_000 }),
    })

    expect(result.outcome).toBe('unreachable')
    expect(wakeForStream).not.toHaveBeenCalled()
  })

  it('reports a wake that timed out distinctly from one that worked', async () => {
    const result = await wakeForRecording(
      3629,
      deps({ wakeForStream: async () => ({ awoke: false, durationMs: 8_000 }) }),
    )
    expect(result.outcome).toBe('did-not-wake')
  })

  it('reports a wake RPC that threw, and never lets it escape', async () => {
    const result = await wakeForRecording(
      3629,
      deps({
        wakeForStream: async () => {
          throw new Error('cap unavailable')
        },
      }),
    )
    expect(result.outcome).toBe('wake-failed')
    expect(result.error).toContain('cap unavailable')
  })
})
