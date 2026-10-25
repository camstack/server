import { describe, expect, it } from 'vitest'
import { electByShare } from '../share-election.js'
import type { ShareCandidate } from '../share-election.js'

function cand(
  key: string,
  share: number,
  running = 0,
  extra: Partial<ShareCandidate> = {},
): ShareCandidate {
  return { key, share, running, capped: false, saturated: false, ...extra }
}

/** Elect `n` sessions in a row, each one adding to the elected candidate's count. */
function run(candidates: readonly ShareCandidate[], n: number): Record<string, number> {
  let current = candidates
  const counts: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const e = electByShare(current)
    if (e.kind !== 'elected') throw new Error('nothing elected')
    counts[e.key] = (counts[e.key] ?? 0) + 1
    current = current.map((c) => (c.key === e.key ? { ...c, running: c.running + 1 } : c))
  }
  return counts
}

describe('electByShare', () => {
  it('sends the first session of an empty cluster to the highest share', () => {
    const e = electByShare([cand('hub', 20), cand('mac', 70), cand('n100', 10)])
    expect(e).toMatchObject({ kind: 'elected', key: 'mac', reason: 'share' })
  })

  it('makes the concurrent distribution track the shares', () => {
    expect(run([cand('hub', 20), cand('mac', 70), cand('n100', 10)], 10)).toEqual({
      mac: 7,
      hub: 2,
      n100: 1,
    })
  })

  it('counts sessions already running (pins included) toward the share', () => {
    // mac already holds 7 of the 7 running — the next two go elsewhere.
    const e = electByShare([cand('hub', 20), cand('mac', 70, 7), cand('n100', 10)])
    expect(e).toMatchObject({ kind: 'elected', key: 'hub', reason: 'share' })
  })

  it('breaks an equal deficit by the higher share, then by key', () => {
    expect(electByShare([cand('b', 50), cand('a', 50)])).toMatchObject({ key: 'a' })
    expect(electByShare([cand('a', 1), cand('b', 3)])).toMatchObject({ key: 'b' })
  })

  it('yields to a free candidate when the turn holder is at its cap', () => {
    const e = electByShare([
      cand('mac', 70, 0, { capped: true }),
      cand('hub', 20),
      cand('n100', 10),
    ])
    expect(e).toMatchObject({
      kind: 'elected',
      key: 'hub',
      reason: 'yield',
      turnKey: 'mac',
      yieldReason: 'at-cap',
    })
  })

  it('yields when the turn holder is saturated, and never onto a saturated one', () => {
    const e = electByShare([
      cand('mac', 70, 0, { saturated: true }),
      cand('hub', 20, 0, { saturated: true }),
      cand('n100', 10),
    ])
    expect(e).toMatchObject({ key: 'n100', reason: 'yield', yieldReason: 'saturated' })
  })

  it('prefers the free candidate with the most spare explicit capacity', () => {
    const e = electByShare([
      cand('mac', 70, 0, { capped: true }),
      cand('hub', 20, 1, { spare: 9 }),
      cand('n100', 10, 0, { spare: 1 }),
    ])
    expect(e).toMatchObject({ key: 'hub', reason: 'yield' })
  })

  it('stays with the turn holder when nobody is free (every candidate full)', () => {
    const e = electByShare([
      cand('mac', 70, 0, { saturated: true }),
      cand('hub', 20, 0, { saturated: true }),
    ])
    expect(e).toMatchObject({ key: 'mac', reason: 'share' })
  })

  it('elects nothing when every candidate is capped', () => {
    expect(electByShare([cand('mac', 70, 0, { capped: true })])).toEqual({ kind: 'none' })
    expect(electByShare([])).toEqual({ kind: 'none' })
  })

  it('a float-noise deficit tie still goes to the higher share (0.7×2−1 vs 0.2×2)', () => {
    const e = electByShare([cand('hub', 20), cand('mac', 70, 1), cand('n100', 10)])
    expect(e).toMatchObject({ key: 'mac' })
  })

  it('treats a zero or negative share as unwanted but still electable', () => {
    expect(run([cand('a', 0), cand('b', 1)], 3)).toEqual({ b: 3 })
    expect(electByShare([cand('a', 0)])).toMatchObject({ key: 'a' })
  })
})

describe('electByShare — history of non-overlapping sessions', () => {
  /** Sequential sessions: nothing is running at any election, only history. */
  function sequential(shares: Readonly<Record<string, number>>, n: number): Record<string, number> {
    const counts: Record<string, number> = {}
    for (let i = 0; i < n; i++) {
      const e = electByShare(
        Object.entries(shares).map(([key, share]) =>
          cand(key, share, 0, { recent: counts[key] ?? 0 }),
        ),
      )
      if (e.kind !== 'elected') throw new Error('nothing elected')
      counts[e.key] = (counts[e.key] ?? 0) + 1
    }
    return counts
  }

  it('splits 30 sequential sessions evenly over three equal shares', () => {
    expect(
      sequential({ 'edgetpu:pci': 100, 'edgetpu:pci:1': 100, 'edgetpu:usb': 100 }, 30),
    ).toEqual({ 'edgetpu:pci': 10, 'edgetpu:pci:1': 10, 'edgetpu:usb': 10 })
  })

  it('splits sequential sessions in proportion to 100:100:10', () => {
    const c = sequential({ a: 100, b: 100, c: 10 }, 210)
    expect(c['a']).toBeGreaterThanOrEqual(98)
    expect(c['a']).toBeLessThanOrEqual(102)
    expect(c['b']).toBeGreaterThanOrEqual(98)
    expect(c['c']).toBeGreaterThanOrEqual(8)
    expect(c['c']).toBeLessThanOrEqual(12)
  })
})
