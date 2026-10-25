import { describe, expect, it } from 'vitest'
import { buildCamStreamId, parseCamStreamId, streamLabel } from '../stream-routing.js'

describe('stream-routing — flv kind', () => {
  it('single-channel: flv:main round-trips', () => {
    const id = buildCamStreamId('flv', 0, 'main', 1)
    expect(id).toBe('flv:main')
    const parts = parseCamStreamId(id, 0)
    expect(parts).toEqual({ kind: 'flv', channel: 0, profile: 'main' })
  })

  it('multi-channel: flv:ch0-main round-trips', () => {
    const id = buildCamStreamId('flv', 0, 'main', 4)
    expect(id).toBe('flv:ch0-main')
    const parts = parseCamStreamId(id, 0)
    expect(parts).toEqual({ kind: 'flv', channel: 0, profile: 'main' })
  })

  it('multi-channel: flv:ch3-sub carries the channel through parse', () => {
    const id = buildCamStreamId('flv', 3, 'sub', 4)
    expect(id).toBe('flv:ch3-sub')
    const parts = parseCamStreamId(id, 0)
    expect(parts).toEqual({ kind: 'flv', channel: 3, profile: 'sub' })
  })

  it('renders an "FLV" prefixed label', () => {
    expect(streamLabel({ profile: 'main' }, 'flv')).toBe('FLV Main')
  })
})
