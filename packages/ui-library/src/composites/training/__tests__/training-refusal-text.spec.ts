import { describe, expect, it } from 'vitest'
import { trainingRefusalText } from '../training-refusal-text'

describe('trainingRefusalText', () => {
  it('names every refusal in words, never as a code', () => {
    for (const reason of [
      'unknown-collection',
      'still-unavailable',
      'still-busy',
      'unreadable-image',
      'write-failed',
    ] as const) {
      const text = trainingRefusalText(reason)
      expect(text).not.toContain(reason)
      expect(text.length).toBeGreaterThan(10)
    }
  })

  it('appends the hub detail when there is one', () => {
    expect(trainingRefusalText('still-unavailable', 'a gap')).toMatch(/\(a gap\)$/)
  })
})
