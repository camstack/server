import { describe, expect, it } from 'vitest'
import { episodeEdge, nextEpisodeId, type EpisodeView } from '../alert-episode-policy.js'

const view = (over: Partial<EpisodeView> = {}): EpisodeView => ({
  status: 'active',
  severity: 'critical',
  episodeId: 'a@1',
  ...over,
})

describe('nextEpisodeId', () => {
  it('opens an episode for a new alert', () => {
    expect(
      nextEpisodeId({
        alertId: 'a',
        previous: null,
        incomingKey: undefined,
        now: 5,
      }),
    ).toBe('a@5')
  })
  it('keeps the episode while the alert is open, whatever the emitter re-stamps', () => {
    expect(
      nextEpisodeId({
        alertId: 'a',
        previous: view(),
        incomingKey: undefined,
        now: 99,
      }),
    ).toBe('a@1')
    expect(
      nextEpisodeId({
        alertId: 'a',
        previous: view({ episodeKey: 'k' }),
        incomingKey: 'k',
        now: 99,
      }),
    ).toBe('a@1')
  })
  it('opens a new episode after completion or dismissal, or when the emitter marks one', () => {
    for (const status of ['completed', 'dismissed'] as const) {
      expect(
        nextEpisodeId({
          alertId: 'a',
          previous: view({ status }),
          incomingKey: undefined,
          now: 7,
        }),
      ).toBe('a@7')
    }
    expect(
      nextEpisodeId({
        alertId: 'a',
        previous: view({ episodeKey: 'k' }),
        incomingKey: 'k2',
        now: 8,
      }),
    ).toBe('a@8')
  })
})

describe('episodeEdge', () => {
  it('raises a new critical or error episode, never warning or info', () => {
    expect(episodeEdge(null, view())).toBe('raised')
    expect(episodeEdge(null, view({ severity: 'error' }))).toBe('raised')
    expect(episodeEdge(null, view({ severity: 'warning' }))).toBeNull()
    expect(episodeEdge(null, view({ severity: 'info' }))).toBeNull()
  })
  it('says nothing about an open episode that continues', () => {
    expect(episodeEdge(view(), view())).toBeNull()
  })
  it('re-raises on escalation error to critical or warning to error, not on a downgrade', () => {
    expect(episodeEdge(view({ severity: 'error' }), view({ severity: 'critical' }))).toBe('raised')
    expect(episodeEdge(view({ severity: 'warning' }), view({ severity: 'error' }))).toBe('raised')
    expect(episodeEdge(view({ severity: 'critical' }), view({ severity: 'error' }))).toBeNull()
  })
  it('resolves an open critical/error episode once, when it closes', () => {
    expect(episodeEdge(view(), view({ status: 'dismissed' }))).toBe('resolved')
    expect(episodeEdge(view({ status: 'dismissed' }), view({ status: 'dismissed' }))).toBeNull()
    expect(
      episodeEdge(
        view({ severity: 'warning' }),
        view({ severity: 'warning', status: 'completed' }),
      ),
    ).toBeNull()
  })
  it('a new episode id on an open alert raises again (the old one was closed elsewhere)', () => {
    expect(episodeEdge(view(), view({ episodeId: 'a@2' }))).toBe('raised')
  })
})
