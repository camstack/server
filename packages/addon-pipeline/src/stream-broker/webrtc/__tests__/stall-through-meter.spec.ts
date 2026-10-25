/**
 * The stall rule judged through the REAL meter on modelled streams — the tracker
 * specs feed ratios directly, which proves nothing about what the meter would
 * have produced from the bytes (review minor 9).
 */
import { describe, it, expect } from 'vitest'
import { StallTracker, buildStallSample } from '../stall-tracker.js'
import { ADAPTIVE_CONFIG, ADAPTIVE_DELIVERY_CONFIG } from '../adaptive-config.js'
import { DeliveryMeter, SendHistory, deliveryWindowMs } from '../delivery-meter.js'
import { framesBetween, recordSent, type RungShape } from './sparse-rung-sim.js'

const SPAN = ADAPTIVE_DELIVERY_CONFIG.clientSampleSpanMs

/** Run `seconds` of `shape`, the client receiving only the frames `lands` accepts. */
function runTracker(
  shape: RungShape,
  lands: (bytes: number, isIdr: boolean) => boolean,
  seconds: number,
): boolean {
  const history = new SendHistory(ADAPTIVE_DELIVERY_CONFIG.historySpanMs)
  const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
  const tracker = new StallTracker(ADAPTIVE_CONFIG)
  const windowMs = deliveryWindowMs(shape.idrIntervalMs, ADAPTIVE_DELIVERY_CONFIG)
  let stalled = false
  for (let now = SPAN; now <= seconds * 1000; now += SPAN) {
    recordSent(history, shape, now - SPAN, now)
    const clientAt = now - 700
    const got = framesBetween(shape, clientAt - SPAN, clientAt)
      .filter((f) => lands(f.bytes, f.bytes === shape.idrBytes))
      .reduce((sum, f) => sum + f.bytes, 0)
    if (clientAt - SPAN >= 0) meter.observe(Math.round((got * 8) / SPAN), clientAt + 40)
    tracker.observe(
      buildStallSample({
        delivery: meter.evaluate(history, windowMs, now),
        recent: meter.evaluateNewest(history, now),
        clientReporting: meter.isReporting(now),
        serverSending: true,
        adaptiveSessionsOnDevice: 1,
      }),
      now,
    )
    stalled = stalled || tracker.isStalled(now)
  }
  return stalled
}

describe('stall rule through the meter', () => {
  it('a steady ~40 kbps rung whose IDRs never lift a 2 s window over 64 kbps is NOT a stall', () => {
    // 30 kbps of P-frames + a 5 KB IDR every 4 s: every report 30–50 kbps,
    // all under the old absolute 64 kbps floor — which confirmed a stall here.
    const quiet: RungShape = { pFrameKbps: 30, idrBytes: 5_000, idrIntervalMs: 4_000, fps: 25 }
    expect(runTracker(quiet, () => true, 60)).toBe(false)
  })

  it('an IDR burst reaching the client cannot mask a stall: only the IDRs land on a 1.8 Mbps rung', () => {
    // Each report holding an IDR reads ~600 kbps — the old 128 kbps recovery
    // floor cleared the stall on it every other tick.
    const mid: RungShape = { pFrameKbps: 1_500, idrBytes: 150_000, idrIntervalMs: 4_000, fps: 25 }
    expect(runTracker(mid, (_bytes, isIdr) => isIdr, 60)).toBe(true)
  })
})
