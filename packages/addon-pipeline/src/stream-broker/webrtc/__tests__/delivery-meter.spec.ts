import { describe, it, expect } from 'vitest'
import { DeliveryMeter, SendHistory, deliveryWindowMs } from '../delivery-meter.js'
import { ADAPTIVE_DELIVERY_CONFIG } from '../adaptive-config.js'
import { HALL_SUB, clientReportKbps, recordSent } from './sparse-rung-sim.js'

const SPAN = ADAPTIVE_DELIVERY_CONFIG.clientSampleSpanMs

describe('SendHistory', () => {
  it('sums what was sent inside a range, to the nearest bucket edge', () => {
    const h = new SendHistory(32_000)
    h.record(1_000, 10_000)
    h.record(2_000, 10_600)
    h.record(4_000, 12_100)
    expect(h.bitsBetween(10_000, 12_000)).toBe(3_000 * 8)
    expect(h.bitsBetween(12_000, 14_000)).toBe(4_000 * 8)
    expect(h.bitsBetween(0, 20_000)).toBe(7_000 * 8)
    // An edge 40 ms off a boundary rounds to it: the frame sent at 12 100 is
    // inside a window starting at 12 040 and outside one ending at 12 040.
    expect(h.bitsBetween(12_040, 14_000)).toBe(4_000 * 8)
    expect(h.bitsBetween(10_000, 12_040)).toBe(3_000 * 8)
  })

  it('forgets what fell out of its span instead of misattributing it', () => {
    const h = new SendHistory(4_000)
    h.record(1_000, 0)
    // 64 s later the ring slot is reused; the old bytes must not leak in.
    h.record(500, 64_000)
    expect(h.bitsBetween(0, 250)).toBe(0)
    expect(h.bitsBetween(64_000, 64_250)).toBe(500 * 8)
  })
})

describe('deliveryWindowMs', () => {
  it('covers at least one GOP, never less than the minimum, never more than the cap', () => {
    expect(deliveryWindowMs(4_021, ADAPTIVE_DELIVERY_CONFIG)).toBe(4_021)
    expect(deliveryWindowMs(500, ADAPTIVE_DELIVERY_CONFIG)).toBe(
      ADAPTIVE_DELIVERY_CONFIG.minWindowMs,
    )
    // Unknown IDR interval (a freshly started broker reports 0) is the minimum.
    expect(deliveryWindowMs(0, ADAPTIVE_DELIVERY_CONFIG)).toBe(ADAPTIVE_DELIVERY_CONFIG.minWindowMs)
    expect(deliveryWindowMs(null, ADAPTIVE_DELIVERY_CONFIG)).toBe(
      ADAPTIVE_DELIVERY_CONFIG.minWindowMs,
    )
    expect(deliveryWindowMs(120_000, ADAPTIVE_DELIVERY_CONFIG)).toBe(
      ADAPTIVE_DELIVERY_CONFIG.maxWindowMs,
    )
  })
})

describe('DeliveryMeter — received vs sent over the same windows', () => {
  /**
   * The case that froze the ladder: the client's 2 s windows alternate between
   * one holding an IDR (~160 kbps) and one of P-frames only (~41 kbps). Taken
   * one at a time, half of them "look" like a crawling link. Over a GOP, the
   * client received what the broker sent.
   */
  it('reads a sparse, fully delivered rung as ~1.0 even though its 2 s windows alternate', () => {
    const history = new SendHistory(32_000)
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
    const reports: number[] = []
    for (let end = SPAN; end <= 30_000; end += SPAN) {
      recordSent(history, HALL_SUB, end - SPAN, end)
      // The hub stamps the report on receipt, ~40 ms after the client window closed.
      const kbps = clientReportKbps(HALL_SUB, end, SPAN, 1)
      reports.push(kbps)
      meter.observe(kbps, end + 40)
    }
    // The premise: the per-window reports straddle the old 128 kbps floor.
    expect(Math.min(...reports)).toBeLessThan(64)
    expect(Math.max(...reports)).toBeGreaterThan(128)

    const w = meter.evaluate(
      history,
      deliveryWindowMs(HALL_SUB.idrIntervalMs, ADAPTIVE_DELIVERY_CONFIG),
      30_100,
    )
    expect(w).not.toBeNull()
    expect(w!.windowMs).toBeGreaterThanOrEqual(HALL_SUB.idrIntervalMs)
    expect(w!.receivedKbps / w!.sentKbps).toBeGreaterThan(0.9)
    expect(w!.receivedKbps / w!.sentKbps).toBeLessThan(1.1)
  })

  it('reads a link that lands a fraction of the bytes as that fraction', () => {
    const history = new SendHistory(32_000)
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
    for (let end = SPAN; end <= 20_000; end += SPAN) {
      recordSent(history, HALL_SUB, end - SPAN, end)
      meter.observe(clientReportKbps(HALL_SUB, end, SPAN, 0.1), end)
    }
    const w = meter.evaluate(history, 8_000, 20_000)
    expect(w).not.toBeNull()
    expect(w!.receivedKbps / w!.sentKbps).toBeCloseTo(0.1, 1)
  })

  it('is unknown (null), never zero, until the client has covered a whole window', () => {
    const history = new SendHistory(32_000)
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
    recordSent(history, HALL_SUB, 0, 2_000)
    meter.observe(80, 2_000)
    expect(meter.evaluate(history, 4_021, 2_100)).toBeNull()
  })

  it('is unknown when the newest report is stale — a client that went away says nothing', () => {
    const history = new SendHistory(32_000)
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
    for (let end = SPAN; end <= 8_000; end += SPAN) {
      recordSent(history, HALL_SUB, end - SPAN, end)
      meter.observe(clientReportKbps(HALL_SUB, end, SPAN, 1), end)
    }
    expect(meter.evaluate(history, 4_000, 8_000)).not.toBeNull()
    expect(
      meter.evaluate(history, 4_000, 8_000 + ADAPTIVE_DELIVERY_CONFIG.maxClientSampleAgeMs + 1),
    ).toBeNull()
  })

  it('ignores a report that describes time before this session existed', () => {
    const history = new SendHistory(32_000)
    // The meter belongs to a session that started at t=10 s (a re-offer): the
    // device-scoped report stamped at 11 s describes the PREVIOUS session.
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 10_000)
    meter.observe(5_000, 11_000)
    recordSent(history, HALL_SUB, 10_000, 16_000)
    meter.observe(clientReportKbps(HALL_SUB, 14_000, SPAN, 1), 14_000)
    meter.observe(clientReportKbps(HALL_SUB, 16_000, SPAN, 1), 16_000)
    const w = meter.evaluate(history, 4_000, 16_000)
    expect(w).not.toBeNull()
    expect(w!.receivedKbps / w!.sentKbps).toBeGreaterThan(0.8)
  })

  it('counts the same report once, however many ticks read it', () => {
    const history = new SendHistory(32_000)
    const meter = new DeliveryMeter(ADAPTIVE_DELIVERY_CONFIG, 0)
    recordSent(history, HALL_SUB, 0, 4_000)
    meter.observe(clientReportKbps(HALL_SUB, 2_000, SPAN, 1), 2_000)
    meter.observe(clientReportKbps(HALL_SUB, 2_000, SPAN, 1), 2_000)
    meter.observe(clientReportKbps(HALL_SUB, 2_000, SPAN, 1), 2_000)
    // One 2 s report is not a 4 s window.
    expect(meter.evaluate(history, 4_000, 2_100)).toBeNull()
  })
})
