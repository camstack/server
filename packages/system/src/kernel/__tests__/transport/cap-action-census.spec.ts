/**
 * The per-ACTION byte census: which cap METHOD moves the bytes, and how much
 * of each one the parent forwarded without reading (D456).
 *
 * D454 gave the `[mem]` line the peer and the kind. It closed by saying the
 * remaining question — WHICH METHOD originates the 30–240 MB/min hub-main
 * writes to `pipeline-analytics` — needs a per-action byte census, and that
 * `socket-traffic.ts` deliberately keeps none. This is that census.
 */
import { describe, expect, it } from 'vitest'
import {
  CAP_ACTION_OVERFLOW_LABEL,
  CAP_ACTION_UNLABELLED,
  capActionLabel,
  createCapActionCensus,
  diffCapActionCensus,
  EMPTY_CAP_ACTION_READING,
  MAX_CAP_ACTIONS_PER_PEER,
} from '../../transport/cap-action-census.js'

const emptyBefore = EMPTY_CAP_ACTION_READING

describe('the action label', () => {
  it('names cap and method for both cap envelopes', () => {
    expect(
      capActionLabel({ kind: 'cap-call-out', capName: 'device-state', method: 'getAll' }),
    ).toBe('device-state.getAll')
    expect(capActionLabel({ kind: 'cap-call', capName: 'audio-codec', method: 'pullPcm' })).toBe(
      'audio-codec.pullPcm',
    )
  })

  it('refuses to label anything that is not a cap call', () => {
    expect(capActionLabel({ kind: 'register', childId: 'x' })).toBeNull()
    expect(capActionLabel({ kind: 'addon-call', addonId: 'a', target: 'routes' })).toBeNull()
    expect(capActionLabel(undefined)).toBeNull()
    expect(capActionLabel('nonsense')).toBeNull()
  })
})

describe('the census', () => {
  it('charges request and response bytes to the action, per peer', () => {
    const census = createCapActionCensus()
    census.record('analytics', 'device-state.getAllSnapshots', 400, 907_000)
    census.record('analytics', 'device-state.getAllSnapshots', 400, 900_000)
    census.record('analytics', 'settings-store.get', 300, 2_200)

    const peer = census.read().get('analytics')
    expect(peer?.get('device-state.getAllSnapshots')).toEqual({
      calls: 2,
      reqBytes: 800,
      resBytes: 1_807_000,
      raw: 0,
      decoded: 0,
    })
    expect(peer?.get('settings-store.get')?.resBytes).toBe(2_200)
  })

  it('splits each action into what was forwarded and what was decoded', () => {
    const census = createCapActionCensus()
    census.record('orchestrator', 'audio-chunks.push', 13_500, 20)
    census.recordForward('orchestrator', 'audio-chunks.push', 'raw')
    census.record('orchestrator', 'audio-chunks.push', 13_500, 20)
    census.recordForward('orchestrator', 'audio-chunks.push', 'decoded')
    census.recordForward('orchestrator', 'audio-chunks.push', 'raw')

    expect(census.read().get('orchestrator')?.get('audio-chunks.push')).toMatchObject({
      raw: 2,
      decoded: 1,
    })
  })

  it('keeps bytes that carry no action under an explicit label, never silently', () => {
    const census = createCapActionCensus()
    census.recordUnlabelled('recorder', 900)
    census.recordUnlabelled('recorder', 100)

    expect(census.read().get('recorder')?.get(CAP_ACTION_UNLABELLED)).toMatchObject({
      reqBytes: 0,
      resBytes: 1_000,
    })
  })

  it('bounds the distinct actions per peer and names the overflow rather than dropping it', () => {
    const census = createCapActionCensus()
    for (let i = 0; i < MAX_CAP_ACTIONS_PER_PEER + 10; i += 1) {
      census.record('chatty', `cap.m${i}`, 10, 100)
    }
    const peer = census.read().get('chatty')
    expect(peer).toBeDefined()
    // The map never grows past the bound (+1 for the overflow bucket itself).
    expect((peer?.size ?? 0) <= MAX_CAP_ACTIONS_PER_PEER + 1).toBe(true)
    // …and the bytes it could not name are still on the record.
    expect(peer?.get(CAP_ACTION_OVERFLOW_LABEL)?.calls).toBe(10)
    expect(peer?.get(CAP_ACTION_OVERFLOW_LABEL)?.resBytes).toBe(1_000)
  })
})

describe('the window', () => {
  it('reports the delta since the previous reading, not the total since boot', () => {
    const census = createCapActionCensus()
    census.record('analytics', 'device-state.getAllSnapshots', 100, 1_000)
    const baseline = census.read()
    census.record('analytics', 'device-state.getAllSnapshots', 100, 4_000)
    const second = diffCapActionCensus(baseline, census.read(), 3)
    expect(second.top[0]?.resBytes).toBe(4_000)
    expect(second.top[0]?.calls).toBe(1)
  })

  it('reads a SNAPSHOT, so a baseline cannot alias the counters it is measured against', () => {
    // The counters are mutated on the hot path by design. A `read()` that
    // handed back the live maps would make every delta zero — the baseline
    // would advance with the thing it is subtracted from.
    const census = createCapActionCensus()
    census.record('a', 'x.y', 1, 1)
    const baseline = census.read()
    census.record('a', 'x.y', 1, 1)
    expect(baseline.get('a')?.get('x.y')?.calls).toBe(1)
  })

  it('ranks by BYTES and keeps only the top N', () => {
    const census = createCapActionCensus()
    census.record('a', 'small.method', 10, 10) // 1 call, tiny
    for (let i = 0; i < 500; i += 1) census.record('a', 'chatty.method', 100, 100) // many calls
    census.record('a', 'whale.method', 10, 5_000_000) // 1 call, huge

    const w = diffCapActionCensus(emptyBefore, census.read(), 2)
    expect(w.top.map((e) => e.action)).toEqual(['whale.method', 'chatty.method'])
    expect(w.top[0]?.peerId).toBe('a')
  })

  it('reads a respawned peer whose counters went backwards as quiet, never negative', () => {
    const census = createCapActionCensus()
    census.record('a', 'x.y', 100, 100)
    const before = census.read()
    const fresh = createCapActionCensus()
    fresh.record('a', 'x.y', 5, 5)
    const w = diffCapActionCensus(before, fresh.read(), 3)
    expect(w.top.every((e) => e.resBytes >= 0 && e.reqBytes >= 0)).toBe(true)
  })

  it('says what share of the window it could name, so an unnamed majority is visible', () => {
    const census = createCapActionCensus()
    census.record('a', 'named.method', 0, 1_000)
    census.recordUnlabelled('a', 3_000)
    const w = diffCapActionCensus(emptyBefore, census.read(), 3)
    expect(w.labelledBytes).toBe(1_000)
    expect(w.totalBytes).toBe(4_000)
  })
})
