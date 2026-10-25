import { describe, expect, it } from 'vitest'
import { shouldSkipAnnounce, structureFingerprint } from '../reconcile-fingerprint.js'

function entry(brokerIds: string[], plan: unknown): { brokerIds: string[]; plan: unknown } {
  return { brokerIds, plan }
}

describe('structureFingerprint', () => {
  it('is stable across map insertion order', () => {
    const a = new Map([
      ['dev-a', entry(['ha_1'], { cmps: { x: 1 } })],
      ['dev-b', entry(['ha_1'], { cmps: { y: 2 } })],
    ])
    const b = new Map([
      ['dev-b', entry(['ha_1'], { cmps: { y: 2 } })],
      ['dev-a', entry(['ha_1'], { cmps: { x: 1 } })],
    ])
    expect(structureFingerprint(a)).toBe(structureFingerprint(b))
  })

  it('changes when a plan changes', () => {
    const a = new Map([['dev-a', entry(['ha_1'], { cmps: { x: 1 } })]])
    const b = new Map([['dev-a', entry(['ha_1'], { cmps: { x: 2 } })]])
    expect(structureFingerprint(a)).not.toBe(structureFingerprint(b))
  })

  it('changes when broker membership changes', () => {
    const a = new Map([['dev-a', entry(['ha_1'], { cmps: {} })]])
    const b = new Map([['dev-a', entry(['ha_1', 'ha_2'], { cmps: {} })]])
    expect(structureFingerprint(a)).not.toBe(structureFingerprint(b))
  })

  it('changes when a device appears or disappears', () => {
    const a = new Map([['dev-a', entry(['ha_1'], { cmps: {} })]])
    const b = new Map([
      ['dev-a', entry(['ha_1'], { cmps: {} })],
      ['dev-b', entry(['ha_1'], { cmps: {} })],
    ])
    expect(structureFingerprint(a)).not.toBe(structureFingerprint(b))
  })
})

describe('shouldSkipAnnounce', () => {
  it('skips an event-debounced pass whose structure is unchanged', () => {
    expect(shouldSkipAnnounce('structure-changed', 'fp', 'fp')).toBe(true)
  })

  it('never skips when the structure differs', () => {
    expect(shouldSkipAnnounce('structure-changed', 'fp-new', 'fp-old')).toBe(false)
  })

  it('never skips the first pass (no previous fingerprint)', () => {
    expect(shouldSkipAnnounce('structure-changed', 'fp', undefined)).toBe(false)
  })

  it('never skips boot or periodic passes, even with identical structure (D8/D11)', () => {
    expect(shouldSkipAnnounce('boot', 'fp', 'fp')).toBe(false)
    expect(shouldSkipAnnounce('periodic', 'fp', 'fp')).toBe(false)
  })
})
