import { describe, it, expect } from 'vitest'
import { DemuxPathTally } from '../demux-path-tally'

describe('DemuxPathTally — in-process JS vs ffmpeg subprocess', () => {
  it('counts BOTH paths, not just the fallback', () => {
    const t = new DemuxPathTally()
    t.record({ path: 'js' }, 0)
    t.record({ path: 'js' }, 1)
    t.record({ path: 'ffmpeg', reason: 'mp4box parse threw: boom' }, 2)
    const c = t.counts()
    expect(c.js).toBe(2)
    expect(c.ffmpeg).toBe(1)
    expect(c.lastFallbackReason).toBe('mp4box parse threw: boom')
  })

  it('carries the REASON of the fallback out to the caller that logs it', () => {
    const t = new DemuxPathTally()
    const report = t.record({ path: 'ffmpeg', reason: 'no access units' }, 1_000)
    expect(report).not.toBeNull()
    expect(report?.reason).toBe('no access units')
    expect(report?.ffmpegTotal).toBe(1)
    expect(report?.suppressed).toBe(0)
  })

  it('THROTTLES the per-fallback line and reports how many it suppressed', () => {
    const t = new DemuxPathTally()
    expect(t.record({ path: 'ffmpeg', reason: 'a' }, 0)).not.toBeNull()
    expect(t.record({ path: 'ffmpeg', reason: 'b' }, 5_000)).toBeNull()
    expect(t.record({ path: 'ffmpeg', reason: 'c' }, 10_000)).toBeNull()
    const later = t.record({ path: 'ffmpeg', reason: 'd' }, 40_000)
    expect(later).not.toBeNull()
    expect(later?.suppressed).toBe(2)
    expect(later?.ffmpegTotal).toBe(4)
  })

  it('a JS success never produces a report', () => {
    const t = new DemuxPathTally()
    expect(t.record({ path: 'js' }, 0)).toBeNull()
  })

  it('deltaSince gives the per-DRAG window without resetting the session total', () => {
    const t = new DemuxPathTally()
    t.record({ path: 'js' }, 0)
    t.record({ path: 'ffmpeg', reason: 'x' }, 1)
    const mark = t.counts()
    t.record({ path: 'js' }, 2)
    t.record({ path: 'js' }, 3)
    t.record({ path: 'ffmpeg', reason: 'y' }, 4)
    const d = t.deltaSince(mark)
    expect(d.js).toBe(2)
    expect(d.ffmpeg).toBe(1)
    expect(d.lastFallbackReason).toBe('y')
    expect(t.counts().js).toBe(3)
  })
})
