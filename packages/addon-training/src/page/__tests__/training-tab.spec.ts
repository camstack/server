import { describe, expect, it } from 'vitest'
import { readTrainingTab } from '../training-tab.js'

describe('readTrainingTab', () => {
  it('defaults to frames', () => {
    expect(readTrainingTab('')).toBe('frames')
    expect(readTrainingTab('?foo=1')).toBe('frames')
  })

  it('reads known tabs', () => {
    expect(readTrainingTab('?tab=jobs')).toBe('jobs')
    expect(readTrainingTab('?tab=providers')).toBe('providers')
    expect(readTrainingTab('?tab=frames')).toBe('frames')
  })
})
