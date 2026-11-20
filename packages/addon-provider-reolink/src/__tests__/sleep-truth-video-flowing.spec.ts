import { describe, expect, it } from 'vitest'
import {
  decideSleepCommit,
  type SleepCommitInput,
  type SleepCommitSource,
} from '../sleep-state-decision.js'

const NOW = 10_000_000

function claim(overrides: Partial<SleepCommitInput>): ReturnType<typeof decideSleepCommit> {
  return decideSleepCommit({
    current: false,
    next: true,
    source: 'hub-summary',
    // Far outside every grace and hysteresis window: only the new gates can refuse.
    lastFirstHandCommitAt: NOW - 3_600_000,
    nowMs: NOW,
    videoFlowing: false,
    wired: false,
    ...overrides,
  })
}

describe('sleep truth: a second-hand sleep claim never beats flowing video', () => {
  const secondHand: readonly SleepCommitSource[] = ['hub-summary', 'hub-reconcile', 'simple-event']

  it.each(secondHand)('%s is refused while video flows, and names the reason', (source) => {
    const decision = claim({ source, videoFlowing: true })
    expect(decision.kind).toBe('refused')
    if (decision.kind === 'refused') expect(decision.reason).toBe('video-flowing')
  })

  it.each(secondHand)('%s is accepted when no video flows (a genuine sleep)', (source) => {
    expect(claim({ source, videoFlowing: false }).kind).toBe('commit')
  })

  it('does not block a wake while video flows', () => {
    const decision = claim({
      current: true,
      next: false,
      source: 'simple-event',
      videoFlowing: true,
    })
    expect(decision.kind).toBe('commit')
  })
})

describe('wired gate: an adapter-powered camera takes no second-hand sleep flip', () => {
  it.each([
    'hub-summary',
    'hub-reconcile',
    'simple-event',
  ] as const)('%s is refused even with no video', (source) => {
    const decision = claim({ source, wired: true, videoFlowing: false })
    expect(decision.kind).toBe('refused')
    if (decision.kind === 'refused') expect(decision.reason).toBe('wired')
  })

  it('a battery-powered camera is unaffected', () => {
    expect(claim({ wired: false }).kind).toBe('commit')
  })
})
