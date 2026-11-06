import { describe, expect, it } from 'vitest'
import { HeldBackAddons, recordBootHealth } from '../boot-health-snapshot.js'

describe('recordBootHealth', () => {
  it('arms a held-back addon quietly (no failure), and still fails a genuine init failure', () => {
    const calls: string[] = []
    recordBootHealth({
      entries: [
        ['ok', { packageName: '@camstack/addon-ok', initialized: true }],
        ['held', { packageName: '@camstack/addon-held', initialized: false }],
        ['broken', { packageName: '@camstack/addon-broken', initialized: false }],
      ],
      heldBack: new Map([['held', 'installed 0.1.40, requires >= 0.1.41']]),
      monitor: {
        recordSuccess: (_p, id) => calls.push(`success:${id}`),
        recordFailure: (_p, _e, id) => calls.push(`failure:${id}`),
        recordHeldBack: (_p, reason, id) => calls.push(`held:${id}:${reason}`),
      },
    })
    expect(calls).toEqual(['success:ok', 'held:held:installed 0.1.40, requires >= 0.1.41', 'failure:broken'])
  })
})

describe('HeldBackAddons', () => {
  it('holds what the gate defers, releases an id the gate now lets through, leaves other ids alone', () => {
    const held = new HeldBackAddons()
    held.track(['a', 'b'], (defer) => {
      defer('a', 'old a')
      defer('b', 'old b')
    })
    held.track(['a', 'c'], (defer) => defer('c', 'old c'))
    expect([...held.asMap().keys()].sort()).toEqual(['b', 'c'])
    expect(held.has('a')).toBe(false)
    expect(held.has('b')).toBe(true)
  })
})
