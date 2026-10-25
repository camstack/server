import { describe, expect, it } from 'vitest'
import { concernEnablement, effectiveCapabilitySettings } from '../node-enablement'

describe('effectiveCapabilitySettings', () => {
  it('defaults unset hub capabilities to enabled', () => {
    expect(effectiveCapabilitySettings({}, true)).toEqual({
      pipeline: true,
      audio: true,
      ingest: true,
    })
  })

  it('defaults unset non-hub capabilities to disabled', () => {
    expect(effectiveCapabilitySettings({}, false)).toEqual({
      pipeline: false,
      audio: false,
      ingest: false,
    })
  })

  it('uses explicit flags over node defaults', () => {
    expect(
      effectiveCapabilitySettings({ detect: true, audio: true, ingest: false }, false),
    ).toEqual({
      pipeline: true,
      audio: true,
      ingest: false,
    })
  })

  it('ignores the deprecated legacy decode flag entirely (detect ⇒ decode)', () => {
    // A legacy store carrying decode:false must NOT surface any decode
    // concern — decode is always co-located with detection.
    const enablement = effectiveCapabilitySettings({ detect: true, decode: false }, false)
    expect(enablement).toEqual({ pipeline: true, audio: false, ingest: false })
    expect('decode' in enablement).toBe(false)
  })
})

describe('concernEnablement', () => {
  it('reads the matching per-node agent settings row', () => {
    const rows = [
      { nodeId: 'hub', settings: { detect: true, audio: true } },
      { nodeId: 'mac', settings: { detect: true, audio: true } },
    ]
    expect(concernEnablement(rows, 'mac', false)).toEqual({
      pipeline: true,
      audio: true,
      ingest: false,
    })
  })

  it('falls back to node defaults when the row is absent or still loading', () => {
    expect(concernEnablement(undefined, 'hub', true).pipeline).toBe(true)
    expect(concernEnablement([], 'mac', false).pipeline).toBe(false)
  })
})
