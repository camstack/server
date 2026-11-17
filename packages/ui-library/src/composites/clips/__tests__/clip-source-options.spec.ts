import type { Clip, ClipSource } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  clipAtInstant,
  clipLaneSpans,
  clipProviderOptions,
  defaultClipProvider,
} from '../clip-source-options'

const OK = { state: 'ok' } as const

/** Three sources, three providers, one of them serving two rows. */
const THREE: readonly ClipSource[] = [
  { source: 'a:events', label: 'Events A', addonId: 'provider-a', availability: OK },
  { source: 'b:card', label: 'Card', addonId: 'provider-b', availability: OK },
  { source: 'c:cloud', label: 'Cloud', addonId: 'provider-c', availability: OK },
  { source: 'b:nvr', label: 'NVR', addonId: 'provider-b', availability: OK },
  { source: 'orphan', label: 'No addon', availability: OK },
]

function clip(id: string, startMs: number, endMs: number): Clip {
  return { id, source: 's', kind: 'native', timeRange: { startMs, endMs } }
}

describe('clipProviderOptions', () => {
  it('one option per provider, in listed order, labels joined, rows without an addon skipped', () => {
    const options = clipProviderOptions(THREE)
    expect(options.map((o) => o.value)).toEqual(['provider-a', 'provider-b', 'provider-c'])
    expect(options[1]?.label).toBe('Card · NVR')
    expect(options[1]?.sources.map((s) => s.source)).toEqual(['b:card', 'b:nvr'])
  })
})

describe('defaultClipProvider', () => {
  const options = clipProviderOptions(THREE)
  it('prefers the named provider when the camera lists it', () => {
    expect(defaultClipProvider(options, 'provider-c')).toBe('provider-c')
  })
  it('falls back to the first listed, and to null when nothing is listed', () => {
    expect(defaultClipProvider(options, 'absent')).toBe('provider-a')
    expect(defaultClipProvider([])).toBeNull()
  })
})

describe('clipAtInstant', () => {
  const clips = [clip('x', 1_000, 2_000), clip('y', 10_000, 20_000)]
  it('returns the clip holding the instant', () => {
    expect(clipAtInstant(clips, 1_500)?.id).toBe('x')
  })
  it('returns a clip opening shortly after, within the tolerance', () => {
    expect(clipAtInstant(clips, 5_000, 6_000)?.id).toBe('y')
  })
  it('is null when nothing is near', () => {
    expect(clipAtInstant(clips, 5_000, 1_000)).toBeNull()
  })
})

describe('clipLaneSpans', () => {
  it('clamps to the window, drops clips outside, keeps a sliver visible', () => {
    const spans = clipLaneSpans(
      [clip('in', 0, 50), clip('out', 200, 300), clip('tiny', 99, 99.01)],
      0,
      100,
    )
    expect(spans.map((s) => s.clip.id)).toEqual(['in', 'tiny'])
    expect(spans[0]).toMatchObject({ leftPct: 0, widthPct: 50 })
    expect(spans[1]?.widthPct).toBe(0.3)
  })
})
