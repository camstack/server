import { describe, it, expect } from 'vitest'
import { RttWindow } from '../rtt-stability.js'

describe('RttWindow', () => {
  it('is unknown with fewer than three samples, or none at all', () => {
    const w = new RttWindow()
    expect(w.stability(0)).toBe('unknown')
    w.observe(5, 0)
    w.observe(6, 2_000)
    expect(w.stability(2_000)).toBe('unknown')
  })

  it('a LAN jittering by a few ms is stable', () => {
    const w = new RttWindow()
    for (const [i, rtt] of [4, 6, 5, 9, 4].entries()) w.observe(rtt, i * 2_000)
    expect(w.stability(8_000)).toBe('stable')
  })

  it('a queue building (RTT doubling) is unstable', () => {
    const w = new RttWindow()
    for (const [i, rtt] of [40, 45, 80, 140].entries()) w.observe(rtt, i * 2_000)
    expect(w.stability(6_000)).toBe('unstable')
  })

  it('forgets samples older than its window; a 0 or negative RTT is unknown, not "fast"', () => {
    const w = new RttWindow()
    for (const [i, rtt] of [40, 300, 45].entries()) w.observe(rtt, i * 2_000)
    for (const [i, rtt] of [40, 42, 41].entries()) w.observe(rtt, 60_000 + i * 2_000)
    expect(w.stability(64_000)).toBe('stable')
    const z = new RttWindow()
    for (let i = 0; i < 5; i += 1) z.observe(0, i * 2_000)
    expect(z.stability(8_000)).toBe('unknown')
  })
})
