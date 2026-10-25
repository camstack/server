import { describe, it, expect } from 'vitest'
import { ObjectTriggerHealth } from '../object-trigger-health.js'
import type { ObjectTriggerVerdict } from '../object-trigger.js'

const qualified = (deviceId: number): ObjectTriggerVerdict => ({
  qualified: true,
  deviceId,
  macroClass: 'person',
  atMs: 1_700_000_000_000,
})
const notPipeline = (deviceId: number): ObjectTriggerVerdict => ({
  qualified: false,
  reason: 'not-pipeline',
  deviceId,
})
const notObject = (deviceId: number): ObjectTriggerVerdict => ({
  qualified: false,
  reason: 'not-object',
  deviceId,
})
const malformed: ObjectTriggerVerdict = { qualified: false, reason: 'malformed' }

const WINDOW = 60_000

describe('ObjectTriggerHealth', () => {
  it('says nothing until the window closes', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 50; i++) expect(h.record(notPipeline(102), 1_000 + i)).toEqual([])
  })

  it('a TOTAL rejection is flagged — it is the regime nobody saw for weeks', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 20; i++) h.record(notPipeline(102), 1_000)
    const [report] = h.drain(1_000 + WINDOW)
    expect(report).toMatchObject({
      deviceId: 102,
      objectEvents: 20,
      qualified: 0,
      rejectedPct: 100,
      topReason: 'not-pipeline',
      totalRejection: true,
    })
  })

  it('a PARTIAL rejection is not the same thing and is not flagged', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 19; i++) h.record(notPipeline(102), 1_000)
    h.record(qualified(102), 1_000)
    const [report] = h.drain(1_000 + WINDOW)
    expect(report).toMatchObject({ objectEvents: 20, qualified: 1, rejectedPct: 95 })
    expect(report?.totalRejection).toBe(false)
  })

  it('below the sample threshold, zero qualified is not an alarm', () => {
    const h = new ObjectTriggerHealth(WINDOW, 5)
    for (let i = 0; i < 4; i++) h.record(notPipeline(102), 1_000)
    const [report] = h.drain(1_000 + WINDOW)
    expect(report?.objectEvents).toBe(4)
    expect(report?.totalRejection).toBe(false)
  })

  it('not-object does NOT enter the denominator — it is another branch of the topic, not lost work', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 200; i++) h.record(notObject(101), 1_000)
    h.record(qualified(101), 1_000)
    const [report] = h.drain(1_000 + WINDOW)
    // 200 motion/audio events do not make this camera "100% rejected".
    expect(report).toMatchObject({
      deviceId: 101,
      objectEvents: 1,
      qualified: 1,
      otherKinds: 200,
      totalRejection: false,
    })
  })

  it('a stopped camera produces no report', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    h.record(qualified(102), 1_000)
    h.drain(1_000 + WINDOW)
    expect(h.drain(1_000 + 2 * WINDOW)).toEqual([])
  })

  it('keeps cameras separate — that is how you answer "why is 102 worse than 101"', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 10; i++) h.record(notPipeline(102), 1_000)
    for (let i = 0; i < 10; i++) h.record(qualified(101), 1_000)
    const byDevice = new Map(h.drain(1_000 + WINDOW).map((r) => [r.deviceId, r]))
    expect(byDevice.get(102)?.totalRejection).toBe(true)
    expect(byDevice.get(101)?.totalRejection).toBe(false)
  })

  it('unreadable envelopes land in a bucket with no camera, because they name none', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 10; i++) h.record(malformed, 1_000)
    const [report] = h.drain(1_000 + WINDOW)
    expect(report?.deviceId).toBeNull()
    expect(report).toMatchObject({ objectEvents: 10, qualified: 0, topReason: 'malformed' })
  })

  it('the window closes by itself at the first event past the deadline', () => {
    const h = new ObjectTriggerHealth(WINDOW)
    for (let i = 0; i < 10; i++) h.record(notPipeline(102), 1_000)
    const reports = h.record(notPipeline(102), 1_000 + WINDOW)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ objectEvents: 10, totalRejection: true })
    // ...e la finestra successiva riparte pulita.
    expect(h.drain(1_000 + 2 * WINDOW)).toMatchObject([{ objectEvents: 1 }])
  })
})
