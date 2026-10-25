import { describe, it, expect } from 'vitest'
import { isOutOfSpace, StoragePressureTracker } from '../storage-pressure.js'

/**
 * The disk filled on 2026-08-02 and every new track was stored with positions,
 * a class and ZERO snapshots for five hours. Each lost frame was logged; none
 * of those lines said "this camera has stopped storing media". These tests pin
 * the difference between a receipt and an alarm.
 */
describe('recognising a full disk', () => {
  it('matches the real error the storage provider produced', () => {
    // Verbatim from the live hub.
    const err = new Error(
      "ENOSPC: no space left on device, mkdir '/recordings/102/events/track/bec5425c'",
    )
    expect(isOutOfSpace(err)).toBe(true)
  })

  it('matches a structured errno too', () => {
    expect(isOutOfSpace(Object.assign(new Error('nope'), { code: 'ENOSPC' }))).toBe(true)
    expect(isOutOfSpace(Object.assign(new Error('nope'), { code: 'EDQUOT' }))).toBe(true)
  })

  it('does NOT fire on other write failures', () => {
    // A permission error or a missing parent must never trigger a retention
    // response — that is how a transient fault becomes deletion.
    expect(isOutOfSpace(new Error("EACCES: permission denied, open '/recordings/x'"))).toBe(false)
    expect(isOutOfSpace(new Error('ENOENT: no such file or directory'))).toBe(false)
    expect(isOutOfSpace(null)).toBe(false)
  })

  it('does not match a path that merely contains the word', () => {
    expect(isOutOfSpace(new Error("EACCES: denied, open '/mnt/ENOSPC-notes/x'"))).toBe(false)
  })
})

describe('escalating the condition, not the item', () => {
  it('the FIRST failure escalates immediately', () => {
    // The line that should have existed five hours before anyone noticed.
    const t = new StoragePressureTracker(60_000, () => 0)
    const e = t.record(new Error('ENOSPC: no space left on device'), 102)
    expect(e).not.toBeNull()
    expect(e?.first).toBe(true)
    expect(e?.failures).toBe(1)
    expect(e?.deviceIds).toEqual([102])
  })

  it('then goes quiet, and reports the COUNT once per interval', () => {
    let now = 0
    const t = new StoragePressureTracker(60_000, () => now)
    t.record(new Error('ENOSPC: x'), 102)
    for (let i = 0; i < 40; i++) {
      now += 1_000
      expect(t.record(new Error('ENOSPC: x'), 102)).toBeNull()
    }
    now += 30_000
    const e = t.record(new Error('ENOSPC: x'), 101)
    expect(e?.failures).toBe(41)
    expect(e?.first).toBe(false)
    expect([...(e?.deviceIds ?? [])].sort()).toEqual([101, 102])
  })

  it('a non-space error is neither counted nor escalated', () => {
    const t = new StoragePressureTracker(60_000, () => 0)
    expect(t.record(new Error('EACCES: denied'), 102)).toBeNull()
    // …and it did not poison the count for the real one that follows.
    expect(t.record(new Error('ENOSPC: x'), 102)?.failures).toBe(1)
  })

  it('a success clears the state, so a later isolated failure is not an emergency', () => {
    let now = 0
    const t = new StoragePressureTracker(60_000, () => now)
    t.record(new Error('ENOSPC: x'), 102)
    for (let i = 0; i < 5; i++) t.record(new Error('ENOSPC: x'), 102)
    t.noteSuccess()
    now += 61_000
    expect(t.record(new Error('ENOSPC: x'), 102)?.failures).toBe(1)
  })
})
