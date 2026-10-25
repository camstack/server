/**
 * D683 review M4: the orphan audit's track-liveness probe
 * (`buildOrphanScopes`'s `liveTrackIds`, wired to
 * `PipelineAnalyticsAddon.liveTrackIdsThroughAliases`) must not call a row
 * orphaned just because it is keyed by an ABSORBED id — a row still keyed by
 * `B` is track-owned for as long as `B`'s alias survivor (`A`) is alive.
 * Without this, every row a late fusion-adjacent write left under an
 * absorbed id becomes a false orphan one grace period later: counted in
 * report mode, DELETED in reclaim mode, while its survivor still lives.
 *
 * Through the booted addon (real `TrackStore` + `TrackAliasStore`), not a
 * hand-built fake — this is a liveness PROBE, and the fake would have to
 * reimplement `TrackStore.existingTrackIds` to be worth anything.
 *
 * Disarm (restored): in `liveTrackIdsThroughAliases`, return `direct`
 * unconditionally (skip the alias-resolution round) — "an absorbed id whose
 * survivor is alive counts as live" fails.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { TrackStore } from '../store/track-store.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'

const DEVICE_ID = 947

function trackAliasStoreOf(booted: Booted): TrackAliasStore {
  const store: unknown = Reflect.get(booted.addon, 'trackAliasStore')
  if (!(store instanceof TrackAliasStore)) throw new Error('trackAliasStore not built')
  return store
}

function trackStoreOf(booted: Booted): TrackStore {
  const store: unknown = Reflect.get(booted.addon, 'trackStore')
  if (store === null || typeof store !== 'object') throw new Error('trackStore not built')
  return store as TrackStore
}

async function liveTrackIdsThroughAliases(
  booted: Booted,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const fn: unknown = Reflect.get(booted.addon, 'liveTrackIdsThroughAliases')
  if (typeof fn !== 'function') throw new Error('liveTrackIdsThroughAliases not found')
  return fn.call(booted.addon, ids, trackStoreOf(booted)) as Promise<ReadonlySet<string>>
}

describe("the orphan audit's liveness probe resolves aliases (review M4)", () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('an absorbed id whose survivor is alive counts as live; one that is not, does not', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    const aliases = trackAliasStoreOf(booted)
    const trackStore = trackStoreOf(booted)

    // A: a genuinely live (active) track — the survivor.
    trackStore.upsert({
      trackId: 'A',
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp: 1_000,
      position: { x: 0, y: 0, timestamp: 1_000, bbox: { x: 0, y: 0, w: 10, h: 10 } },
      zones: [],
      state: 'new',
    })
    // B is an ABSORBED id — no row of its own, ever — aliased to live A.
    await aliases.record(DEVICE_ID, 'B', 'A', 1_000)
    // Z is aliased to a survivor that itself has no row anywhere (D49: an
    // alias must never be trusted blindly — only a survivor PROVEN alive
    // counts).
    await aliases.record(DEVICE_ID, 'Z', 'dead-survivor', 1_000)

    const live = await liveTrackIdsThroughAliases(booted, ['A', 'B', 'Z', 'nobody'])
    expect(live.has('A'), 'A has its own row').toBe(true)
    expect(live.has('B'), "B's survivor A is alive").toBe(true)
    expect(live.has('Z'), "Z's survivor has no row anywhere").toBe(false)
    expect(live.has('nobody'), 'not an alias, no row').toBe(false)
  })
})
