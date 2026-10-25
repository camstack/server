import { describe, it, expect } from 'vitest'
import { DeferredBirthRegistry } from '../deferred-births.js'

const DEV = 'dev:636'

describe('DeferredBirthRegistry', () => {
  it('counts attempts from the first deferral', () => {
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    expect(r.attemptsFor(DEV, 't1')).toBe(1)
    r.defer(DEV, 't1', 1100)
    expect(r.attemptsFor(DEV, 't1')).toBe(2)
    expect(r.isDeferred(DEV, 't1')).toBe(true)
  })

  it('keeps firstSeenMs across attempts, so the deadline runs from the BIRTH', () => {
    // Refreshing it on each attempt is the bug this pins: every retry would
    // push the deadline out, and a camera with a persistent crop failure would
    // defer a birth forever instead of falling through to the fallback.
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    r.defer(DEV, 't1', 2500)
    expect(r.elapsedMs(DEV, 't1', 3000)).toBe(2000)
    expect(r.exhausted(DEV, 't1', 3100, 99, 2000)).toBe(true)
  })

  it('is exhausted by attempts OR by elapsed, whichever comes first', () => {
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    expect(r.exhausted(DEV, 't1', 1100, 4, 2000)).toBe(false)
    r.defer(DEV, 't1', 1050)
    r.defer(DEV, 't1', 1100)
    r.defer(DEV, 't1', 1150)
    // Four attempts, only 200ms elapsed — the attempt bound is what fires.
    expect(r.exhausted(DEV, 't1', 1200, 4, 2000)).toBe(true)

    const slow = new DeferredBirthRegistry()
    slow.defer(DEV, 't2', 1000)
    // One attempt, but the wall clock ran out — the elapsed bound fires.
    expect(slow.exhausted(DEV, 't2', 4000, 4, 2000)).toBe(true)
  })

  it('an unknown id is never deferred and never exhausted', () => {
    // `exhausted` is asked about ids that may already have been resolved this
    // frame; answering `true` for one would send a decided birth to the
    // fallback path.
    const r = new DeferredBirthRegistry()
    expect(r.isDeferred(DEV, 'ghost')).toBe(false)
    expect(r.attemptsFor(DEV, 'ghost')).toBe(0)
    expect(r.elapsedMs(DEV, 'ghost', 9999)).toBe(0)
    expect(r.exhausted(DEV, 'ghost', 9999, 1, 1)).toBe(false)
  })

  it('resolve forgets it', () => {
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    r.resolve(DEV, 't1')
    expect(r.isDeferred(DEV, 't1')).toBe(false)
    expect(r.size(DEV)).toBe(0)
  })

  it('retain drops ids the tracker no longer carries', () => {
    // An id absent from the frame can never be decided, so holding it leaks.
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    r.defer(DEV, 't2', 1000)
    r.retain(DEV, new Set(['t2']))
    expect(r.isDeferred(DEV, 't1')).toBe(false)
    expect(r.isDeferred(DEV, 't2')).toBe(true)
    expect(r.deferredIds(DEV)).toEqual(['t2'])
  })

  it('retain over an empty frame drops the device entry entirely', () => {
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    r.retain(DEV, new Set())
    expect(r.size(DEV)).toBe(0)
    expect(r.deferredIds(DEV)).toEqual([])
  })

  it('keeps devices apart', () => {
    const r = new DeferredBirthRegistry()
    r.defer('dev:101', 't1', 1000)
    r.defer('dev:102', 't1', 1000)
    r.resolve('dev:101', 't1')
    expect(r.isDeferred('dev:101', 't1')).toBe(false)
    expect(r.isDeferred('dev:102', 't1')).toBe(true)
  })

  it('clearDevice drops the whole device', () => {
    const r = new DeferredBirthRegistry()
    r.defer(DEV, 't1', 1000)
    r.clearDevice(DEV)
    expect(r.size(DEV)).toBe(0)
  })
})
