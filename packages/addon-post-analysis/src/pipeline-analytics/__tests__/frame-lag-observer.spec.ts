import { describe, expect, it } from 'vitest'
import {
  FrameLagObserver,
  isAlarmingLagReport,
  lagVerdict,
  LAG_ALARM_MS,
  LAG_WINDOW_MS,
} from '../frame-lag-observer.js'

/**
 * The observer exists to settle ONE question — see `frame-lag-observer.ts`:
 * when analytics goes silent for 10s and then drains, were the events LATE
 * (starved) or was this process busy (waiting)? Every assertion below is about
 * keeping that answer readable, and about the two ways an instrument on the
 * frame path destroys the thing it measures: CPU cost and log volume.
 */
describe('FrameLagObserver', () => {
  it('reports the first frame of a device immediately, so a deploy proves itself live', () => {
    const obs = new FrameLagObserver()
    const report = obs.observe(102, 1_000, 900, 700)
    expect(report).not.toBeNull()
    expect(report?.deviceId).toBe(102)
    expect(report?.frames).toBe(1)
    expect(report?.busLagMaxMs).toBe(100)
    expect(report?.captureLagMaxMs).toBe(300)
  })

  it('says nothing again until the window elapses — the frame path is not a log source', () => {
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, 1_000, 1_000)
    for (let i = 1; i < 500; i++) {
      expect(obs.observe(102, 1_000 + i, 1_000 + i, 1_000 + i)).toBeNull()
    }
  })

  it('keeps the WORST lag in the window — a 10s stall is never averaged away', () => {
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, 1_000, 1_000) // first frame: reported, window reset
    obs.observe(102, 2_000, 1_990, 1_980) // busLag 10, captureLag 20
    obs.observe(102, 3_000, -7_000, -10_500) // busLag 10_000, captureLag 13_500
    const end = 1_000 + LAG_WINDOW_MS
    const report = obs.observe(102, end, end, end)
    expect(report).not.toBeNull()
    expect(report?.frames).toBe(3)
    expect(report?.busLagMaxMs).toBe(10_000)
    expect(report?.captureLagMaxMs).toBe(13_500)
  })

  it('a window with no lag at all still reports, so a healthy baseline is on the record', () => {
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, 1_000, 1_000)
    const end = 1_000 + LAG_WINDOW_MS
    const report = obs.observe(102, end, end, end)
    expect(report?.frames).toBe(1)
    expect(report?.busLagMaxMs).toBe(0)
    expect(report?.busLagUnknownFrames).toBe(0)
  })

  it('an absent emittedAt is UNKNOWN, never a fabricated 0 (D8 + rolling deploy)', () => {
    const obs = new FrameLagObserver()
    // Every frame here came from a runner too old to stamp `emittedAt`.
    obs.observe(102, 1_000, undefined, 900) // first frame: reported, window reset
    obs.observe(102, 2_000, undefined, 1_900)
    const end = 1_000 + LAG_WINDOW_MS
    const report = obs.observe(102, end, undefined, 1_000)
    expect(report?.frames).toBe(2)
    expect(report?.busLagMaxMs).toBeNull()
    expect(report?.busLagMinMs).toBeNull()
    expect(report?.busLagUnknownFrames).toBe(2)
    // capturedAt is a separate field and must not be dragged down with it.
    expect(report?.captureLagMaxMs).toBe(LAG_WINDOW_MS)
  })

  it('a MIX of stamped and unstamped frames reports both halves', () => {
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, undefined, undefined) // first frame: reported, window reset
    obs.observe(102, 2_000, 1_500, undefined) // busLag 500
    obs.observe(102, 3_000, undefined, undefined)
    const report = obs.observe(102, 1_000 + LAG_WINDOW_MS, undefined, undefined)
    expect(report?.frames).toBe(3)
    expect(report?.busLagMaxMs).toBe(500)
    expect(report?.busLagUnknownFrames).toBe(2)
    expect(report?.captureLagMaxMs).toBeNull()
    expect(report?.captureLagUnknownFrames).toBe(3)
  })

  it('a lag from a SKEWED remote clock is reported as measured, never clamped to 0', () => {
    // `emittedAt` is stamped on the RUNNER's node, `now` is read here. A
    // negative delta means that clock runs ahead; clamping it to 0 would hide
    // the skew and make every absolute busLag number a lie. `busLagMinMs` is
    // what exposes it.
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, 1_000, 1_000)
    obs.observe(102, 2_000, 4_000, 4_000) // busLag -2_000
    const end = 1_000 + LAG_WINDOW_MS
    const report = obs.observe(102, end, end, end)
    expect(report?.busLagMinMs).toBe(-2_000)
    expect(report?.busLagMaxMs).toBe(0)
  })

  it('windows are per device — camera 101 never absorbs 102s stall', () => {
    const obs = new FrameLagObserver()
    obs.observe(101, 1_000, 1_000, 1_000)
    obs.observe(102, 1_000, 1_000, 1_000)
    obs.observe(102, 2_000, -8_000, 2_000) // busLag 10_000
    const end = 1_000 + LAG_WINDOW_MS
    const r101 = obs.observe(101, end, end, end)
    const r102 = obs.observe(102, end, end, end)
    expect(r101?.frames).toBe(1)
    expect(r101?.busLagMaxMs).toBe(0)
    expect(r102?.frames).toBe(2)
    expect(r102?.busLagMaxMs).toBe(10_000)
  })

  it('forgets a device, so a camera that stops being ingested cannot leak a window', () => {
    const obs = new FrameLagObserver()
    obs.observe(102, 1_000, 1_000, 1_000)
    obs.forget(102)
    // Fresh device again: reported immediately rather than folded into the old window.
    expect(obs.observe(102, 1_100, 1_100, 1_100)).not.toBeNull()
  })

  it('an alarming window is the one an operator has to see', () => {
    const obs = new FrameLagObserver()
    const healthy = obs.observe(102, 1_000, 1_000, 1_000)
    expect(healthy && isAlarmingLagReport(healthy)).toBe(false)
    const obs2 = new FrameLagObserver()
    const stalled = obs2.observe(102, 1_000, 1_000 - LAG_ALARM_MS, 1_000)
    expect(stalled && isAlarmingLagReport(stalled)).toBe(true)
    // Unknown must not read as alarming — that is exactly the fabricated
    // verdict D8 forbids.
    const obs3 = new FrameLagObserver()
    const unknown = obs3.observe(102, 1_000, undefined, undefined)
    expect(unknown && isAlarmingLagReport(unknown)).toBe(false)
  })

  it('names the mechanism, and refuses to name one it cannot see', () => {
    const obs = new FrameLagObserver()
    // A window whose events arrived 13 s late: the runner/hub-main delivered
    // late and analytics is innocent for it.
    expect(lagVerdict(obs.observe(102, 13_000, 0, 0)!)).toBe('starved')
    // Prompt delivery. If work STILL landed late in this window, the stall is
    // inside processFrame — that is the whole point of the number.
    const obs2 = new FrameLagObserver()
    expect(lagVerdict(obs2.observe(102, 1_000, 990, 900)!)).toBe('delivered-on-time')
    // No stamp at all says nothing, and must not be folded into either.
    const obs3 = new FrameLagObserver()
    expect(lagVerdict(obs3.observe(102, 1_000, undefined, 900)!)).toBe('unknown')
  })

  it('costs well under a microsecond per frame — the budget it has to fit in', () => {
    // The live path is ~672 frames/s (12 cameras x 56 frames/10 s). At 1 us per
    // frame the instrument costs 0.07% of one core; an instrument that needs a
    // stall to measure a stall is worthless. Ceiling is generous: CI is noisy.
    const obs = new FrameLagObserver()
    const iterations = 200_000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) {
      obs.observe(600 + (i % 12), 1_000 + i, 1_000 + i, 900 + i)
    }
    const perCallNs = Number(process.hrtime.bigint() - t0) / iterations
    expect(perCallNs).toBeLessThan(1_000)
  })
})
