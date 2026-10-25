import { describe, it, expect } from 'vitest'
import { FeedOrigin, MonotonicClock, msToRtp90k } from '../feed-clock'

describe('msToRtp90k', () => {
  it('converts elapsed ms to a 90 kHz tick count', () => {
    expect(msToRtp90k(0)).toBe(0)
    expect(msToRtp90k(1000)).toBe(90000)
    expect(msToRtp90k(33)).toBe(2970)
  })
})

describe('MonotonicClock', () => {
  it('produces a strictly increasing 90 kHz timeline from per-AU source deltas', () => {
    const c = new MonotonicClock()
    expect(c.stamp(1000)).toBe(0)
    expect(c.stamp(1040)).toBe(msToRtp90k(40))
    expect(c.stamp(1080)).toBe(msToRtp90k(80))
  })
  it('resets the source anchor on seek so a new segment does not rewind the output clock', () => {
    const c = new MonotonicClock()
    c.stamp(1000)
    c.stamp(1040)
    c.markSeek()
    const afterSeek = c.stamp(50000) // unrelated source pts after seek
    expect(afterSeek).toBeGreaterThan(msToRtp90k(40))
  })
})

describe('MonotonicClock rate factor', () => {
  it('halves the output spacing at 2x', () => {
    const c = new MonotonicClock()
    c.setRate(2)
    expect(c.stamp(0)).toBe(0)
    expect(c.stamp(40)).toBe(msToRtp90k(20))
    expect(c.stamp(80)).toBe(msToRtp90k(40))
  })

  it('doubles the output spacing at 0.5x', () => {
    const c = new MonotonicClock()
    c.setRate(0.5)
    expect(c.stamp(0)).toBe(0)
    expect(c.stamp(40)).toBe(msToRtp90k(80))
  })

  it('quarters the output spacing at 4x', () => {
    const c = new MonotonicClock()
    c.setRate(4)
    expect(c.stamp(0)).toBe(0)
    expect(c.stamp(400)).toBe(msToRtp90k(100))
  })

  it('rate 1 is the identity (existing behavior unchanged)', () => {
    const c = new MonotonicClock()
    c.setRate(1)
    expect(c.stamp(0)).toBe(0)
    expect(c.stamp(40)).toBe(msToRtp90k(40))
  })

  it('a mid-stream rate change re-anchors: continuous and strictly monotonic across the change', () => {
    const c = new MonotonicClock()
    expect(c.stamp(0)).toBe(0)
    expect(c.stamp(100)).toBe(msToRtp90k(100))
    c.setRate(2) // re-anchor at (src 100, out 100)
    expect(c.stamp(140)).toBe(msToRtp90k(120)) // 100 + 40/2
    c.setRate(0.5) // re-anchor at (src 140, out 120)
    expect(c.stamp(180)).toBe(msToRtp90k(200)) // 120 + 40*2
  })

  it('timestamps stay strictly increasing across many rate flips', () => {
    const c = new MonotonicClock()
    const out: number[] = []
    out.push(c.stamp(0), c.stamp(33), c.stamp(66))
    c.setRate(4)
    out.push(c.stamp(99), c.stamp(132))
    c.setRate(0.25)
    out.push(c.stamp(165), c.stamp(198))
    c.setRate(2)
    out.push(c.stamp(231))
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!)
  })

  it('markSeek nudge scales with rate (output-domain frame gap)', () => {
    const c = new MonotonicClock()
    c.setRate(2)
    c.stamp(0) // out 0
    c.markSeek() // outBase = 0 + 33/2 = 16.5
    expect(c.stamp(5000)).toBe(msToRtp90k(16.5))
  })

  it('non-positive and redundant setRate are no-ops', () => {
    const c = new MonotonicClock()
    c.stamp(0)
    c.setRate(0)
    c.setRate(-1)
    c.setRate(1)
    expect(c.stamp(40)).toBe(msToRtp90k(40))
  })

  it('markDiscontinuity applies the requested output gap UN-scaled (seek marker)', () => {
    const c = new MonotonicClock()
    c.stamp(0)
    c.stamp(100) // out 100
    c.setRate(2)
    c.markDiscontinuity(250)
    // The gap is an intentional discontinuity — rate must NOT shrink it.
    expect(c.stamp(99999)).toBe(msToRtp90k(350))
  })
})

describe('two tracks on ONE origin keep their offset across seeks', () => {
  /**
   * The offset a receiver sees between the tracks, in ms. Video is 90 kHz,
   * audio 48 kHz — the whole point is that the OUTPUT instants agree once
   * both are converted back to ms.
   */
  function skewMs(videoTicks: number, audioTicks: number): number {
    return videoTicks / 90 - audioTicks / 48
  }

  /**
   * Play a second of A/V, then seek, three times over, reporting the skew
   * after each. Source video every 33 ms, audio every 20 ms, both from the
   * same timeline — so the true offset is only the interleave's rounding and
   * must stay there.
   */
  function skewsAcrossSeeks(origin: FeedOrigin | undefined): readonly number[] {
    const video = new MonotonicClock(90_000, origin)
    const audio = new MonotonicClock(48_000, origin)
    let vPts = 0
    let aPts = 0
    let lastV = 0
    let lastA = 0
    const skews: number[] = []
    const playFor = (ms: number): void => {
      const until = vPts + ms
      while (vPts < until) {
        lastV = video.stamp(vPts)
        while (aPts <= vPts) {
          lastA = audio.stamp(aPts)
          aPts += 20
        }
        vPts += 33
      }
    }
    playFor(1000)
    skews.push(skewMs(lastV, lastA))
    for (let i = 0; i < 3; i++) {
      video.markDiscontinuity(250)
      audio.markDiscontinuity(250)
      // A seek forward: both tracks resume from the same new source instant.
      vPts += 5000
      aPts = vPts
      playFor(1000)
      skews.push(skewMs(lastV, lastA))
    }
    return skews
  }

  it('does NOT drift: the skew after three seeks is the skew after none', () => {
    // The bug this exists for. `markDiscontinuity` re-bases on the last
    // output; with one origin per track that is the TRACK'S own last output,
    // so every seek substituted the interleave gap for the real offset — and
    // never gave it back.
    const skews = skewsAcrossSeeks(new FeedOrigin())
    for (const s of skews) {
      // Within one video frame of the first: the residue is the interleave's
      // own rounding, not an accumulating error.
      expect(Math.abs(s - (skews[0] ?? 0)), `skews: ${skews.join(', ')}`).toBeLessThan(33)
    }
  })

  it('and the drift is REAL when the origins are separate', () => {
    // Removing the shared origin must make this file fail, or the test above
    // proves nothing. The assertion is the SHAPE, not a magic number: the
    // skew grows once per seek and never comes back, so how big it gets is
    // the interleave's business — 10 ms a seek on this fixture, 900 ms over
    // three on a real clip with a coarser one.
    const skews = skewsAcrossSeeks(undefined)
    for (let i = 1; i < skews.length; i++) {
      expect(skews[i] ?? 0, `skews: ${skews.join(', ')}`).toBeGreaterThan(skews[i - 1] ?? 0)
    }
  })

  it('two clocks marking the SAME discontinuity open ONE gap, not two', () => {
    // The feeder marks both, in a row, at every seek. Opening the gap twice
    // would put a visible stall in the stream at each one.
    const origin = new FeedOrigin()
    const video = new MonotonicClock(90_000, origin)
    const audio = new MonotonicClock(48_000, origin)
    video.stamp(0)
    audio.stamp(0)
    video.stamp(1000)
    video.markDiscontinuity(250)
    audio.markDiscontinuity(250)
    expect(video.stamp(2000) / 90).toBeCloseTo(1250, 0)
  })

  it('a lone clock is untouched — it gets its own origin', () => {
    // Every other user of this class constructs one clock and must behave
    // exactly as before.
    const solo = new MonotonicClock(90_000)
    solo.stamp(0)
    solo.stamp(1000)
    solo.markDiscontinuity(250)
    expect(solo.stamp(0) / 90).toBeCloseTo(1250, 0)
  })
})
