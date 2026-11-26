import { describe, expect, it } from 'vitest'
import { reasonText } from '../SuggestedDefaultsCard.js'

const t = (key: string, params?: Record<string, unknown>): string =>
  `${key}${params === undefined ? '' : JSON.stringify(params)}`

describe('reasonText', () => {
  it('names the node and the dimension for a cpu-only reason', () => {
    expect(reasonText(t, { kind: 'cpu-only', nodeId: 'hub', dimension: 'fps' })).toContain(
      '"node":"hub"',
    )
  })

  it('carries the 4K figures for a decode reason', () => {
    const text = reasonText(t, {
      kind: 'decode-4k-below-cameras',
      nodeId: 'hub',
      maxStreams: 2,
      cameras: 5,
    })
    expect(text).toContain('"max":2')
    expect(text).toContain('"cameras":5')
  })

  it('says what is missing for an unknown fact instead of guessing', () => {
    const text = reasonText(t, {
      kind: 'unknown',
      nodeId: 'n1',
      dimension: 'stream-profile',
      missing: 'decode-4k',
    })
    expect(text).toContain('defaults.missing.decode-4k')
  })

  it('has a sentence for no serving nodes', () => {
    expect(reasonText(t, { kind: 'no-serving-nodes' })).toBe('defaults.reason.noServingNodes')
  })
})
