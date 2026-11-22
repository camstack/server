import { describe, expect, it } from 'vitest'
import { projectCapSlice } from '../state-projector.js'

/**
 * A player that takes a volume but cannot report one (an infrared TV) either
 * carries `volumeLevel: null` or the driver's own bookkeeping, listed in
 * `assumedFields`. Neither is a reading, and Home Assistant is told neither
 * (D393): no value arrives on that entity, so it reads `unknown`.
 */
const BASE = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
  source: 'HDMI 1',
  availableSources: ['HDMI 1'],
  lastChangedAt: 1,
}

function topicsOf(slice: Readonly<Record<string, unknown>>): readonly string[] {
  const projection = projectCapSlice('camstack-tv1', 'media-player', slice)
  if (projection.kind !== 'values') throw new Error(`expected values, got ${projection.kind}`)
  return projection.values.map((v) => v.topic)
}

function topicEnding(topics: readonly string[], suffix: string): string | undefined {
  return topics.find((topic) => topic.includes(suffix))
}

describe('media-player: a value the driver only assumes is not published as a reading', () => {
  it('publishes a REPORTED volume and mute', () => {
    const topics = topicsOf(BASE)
    expect(topicEnding(topics, 'volume')).toBeDefined()
    expect(topicEnding(topics, 'muted')).toBeDefined()
  })

  it('publishes nothing for a null volume (never 0)', () => {
    const projection = projectCapSlice('camstack-tv1', 'media-player', {
      ...BASE,
      volumeLevel: null,
    })
    if (projection.kind !== 'values') throw new Error('expected values')
    expect(
      topicEnding(
        projection.values.map((v) => v.topic),
        'volume',
      ),
    ).toBeUndefined()
    expect(projection.values.some((v) => v.value === '0')).toBe(false)
  })

  it('publishes nothing for an ASSUMED volume, and still publishes the reported fields', () => {
    const topics = topicsOf({
      ...BASE,
      stateSource: 'assumed',
      assumedFields: ['volumeLevel'],
    })
    expect(topicEnding(topics, 'volume')).toBeUndefined()
    expect(topicEnding(topics, 'muted')).toBeDefined()
  })

  it('publishes nothing for an assumed mute', () => {
    const topics = topicsOf({
      ...BASE,
      stateSource: 'assumed',
      assumedFields: ['isMuted'],
    })
    expect(topicEnding(topics, 'muted')).toBeUndefined()
    expect(topicEnding(topics, 'volume')).toBeDefined()
  })

  it('still publishes an ASSUMED state: a player with no state cannot be used', () => {
    const topics = topicsOf({
      ...BASE,
      state: 'on',
      stateSource: 'assumed',
      assumedFields: ['state', 'volumeLevel'],
    })
    expect(topics.some((topic) => topic.endsWith('/media_player'))).toBe(true)
    expect(topicEnding(topics, 'volume')).toBeUndefined()
  })
})
