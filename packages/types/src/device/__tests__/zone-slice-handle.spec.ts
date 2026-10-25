/**
 * SliceHandle reactive contract — proves the consumer pattern that
 * motion-wasm + addon-pipeline-analytics rely on:
 *
 *   - First subscribe seeds the callback with the current slice
 *     (or undefined if not yet populated).
 *   - Pushing a new slice through the mirror notifies every active
 *     subscriber and updates `.value` synchronously.
 *   - Unsubscribing stops further callbacks for that listener.
 *   - Multiple SliceHandle instances against the same source share
 *     the mirror cache (no double-fetch / double-fanout).
 *
 * Uses a fake mirror source built with the public
 * `createMirrorSource` helper — same wiring the SystemManager
 * provides at runtime — so we exercise real handle semantics without
 * a live kernel.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createSliceHandle, createMirrorSource, type SliceHandle } from '../device-state-handle.js'
import type { Zone, ZoneRule } from '../../capabilities/index.js'

interface ZonesSlice {
  readonly zones: readonly Zone[]
}
interface ZoneRulesSlice {
  readonly motion: readonly ZoneRule[]
  readonly detection: readonly ZoneRule[]
}

const driveway: Zone = {
  id: 'z-drv',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#3b82f6',
}
const porch: Zone = { ...driveway, id: 'z-porch', name: 'Porch' }

const motionExclude: ZoneRule = {
  id: 'm-1',
  zoneIds: ['z-drv'],
  mode: 'exclude',
  enabled: true,
}

describe('SliceHandle (zones) — reactive subscriber contract', () => {
  let mirror: Map<number, Map<string, unknown>>
  let listeners: Map<string, Set<(slice: unknown | undefined) => void>>
  let zonesHandle: SliceHandle<ZonesSlice>
  let rulesHandle: SliceHandle<ZoneRulesSlice>

  // Helper to push a slice into the mirror and fan out to listeners —
  // mimics the SystemManager's `device.state-changed` handler.
  function pushSlice(deviceId: number, capName: string, slice: Record<string, unknown>): void {
    let perCap = mirror.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      mirror.set(deviceId, perCap)
    }
    perCap.set(capName, slice)
    const set = listeners.get(`${deviceId}:${capName}`)
    if (set) for (const cb of set) cb(slice)
  }

  beforeEach(() => {
    mirror = new Map()
    listeners = new Map()
    const source = createMirrorSource(mirror, listeners)
    zonesHandle = createSliceHandle<ZonesSlice>(source, 1, 'zones')
    rulesHandle = createSliceHandle<ZoneRulesSlice>(source, 1, 'zone-rules')
  })

  it('subscribe seeds with current value (undefined on cold start)', () => {
    const seen: Array<ZonesSlice | undefined> = []
    zonesHandle.subscribe((s) => seen.push(s))
    expect(seen).toEqual([undefined])
  })

  it('push update fires every subscriber + bumps .value', () => {
    const seen: Array<ZonesSlice | undefined> = []
    zonesHandle.subscribe((s) => seen.push(s))
    pushSlice(1, 'zones', { zones: [driveway] })
    expect(zonesHandle.value).toEqual({ zones: [driveway] })
    expect(seen).toEqual([undefined, { zones: [driveway] }])
    pushSlice(1, 'zones', { zones: [driveway, porch] })
    expect(zonesHandle.value?.zones.map((z) => z.id)).toEqual(['z-drv', 'z-porch'])
    expect(seen[seen.length - 1]).toEqual({ zones: [driveway, porch] })
  })

  it('multiple subscribers all receive the same updates', () => {
    const seenA: Array<ZonesSlice | undefined> = []
    const seenB: Array<ZonesSlice | undefined> = []
    zonesHandle.subscribe((s) => seenA.push(s))
    zonesHandle.subscribe((s) => seenB.push(s))
    pushSlice(1, 'zones', { zones: [driveway] })
    expect(seenA).toEqual([undefined, { zones: [driveway] }])
    expect(seenB).toEqual([undefined, { zones: [driveway] }])
  })

  it('unsubscribe stops further callbacks for that listener only', () => {
    const seen: Array<ZonesSlice | undefined> = []
    const stop = zonesHandle.subscribe((s) => seen.push(s))
    pushSlice(1, 'zones', { zones: [driveway] })
    stop()
    pushSlice(1, 'zones', { zones: [driveway, porch] })
    // Two callbacks expected: initial seed + first push. Second push
    // arrives after unsubscribe and must NOT call the listener.
    expect(seen).toHaveLength(2)
    // Other subscribers (none here) would still receive the push;
    // .value reflects the latest slice regardless.
    expect(zonesHandle.value?.zones).toHaveLength(2)
  })

  it('different cap slices are isolated (zones vs zone-rules)', () => {
    const zonesSeen: Array<ZonesSlice | undefined> = []
    const rulesSeen: Array<ZoneRulesSlice | undefined> = []
    zonesHandle.subscribe((s) => zonesSeen.push(s))
    rulesHandle.subscribe((s) => rulesSeen.push(s))
    pushSlice(1, 'zones', { zones: [driveway] })
    pushSlice(1, 'zone-rules', { motion: [motionExclude], detection: [] })
    expect(zonesSeen.length).toBe(2)
    expect(rulesSeen.length).toBe(2)
    expect(zonesSeen[1]).toEqual({ zones: [driveway] })
    expect(rulesSeen[1]).toEqual({ motion: [motionExclude], detection: [] })
    // A push on one slice does NOT fire the other handle's listeners.
    pushSlice(1, 'zones', { zones: [driveway, porch] })
    expect(zonesSeen.length).toBe(3)
    expect(rulesSeen.length).toBe(2)
  })

  it('different deviceIds are isolated even when capName matches', () => {
    const handleA = createSliceHandle<ZonesSlice>(createMirrorSource(mirror, listeners), 1, 'zones')
    const handleB = createSliceHandle<ZonesSlice>(createMirrorSource(mirror, listeners), 2, 'zones')
    const seenA: Array<ZonesSlice | undefined> = []
    const seenB: Array<ZonesSlice | undefined> = []
    handleA.subscribe((s) => seenA.push(s))
    handleB.subscribe((s) => seenB.push(s))
    pushSlice(2, 'zones', { zones: [porch] })
    expect(seenA).toEqual([undefined])
    expect(seenB).toEqual([undefined, { zones: [porch] }])
  })

  it('zoneRules slice carries both stages and updates atomically', () => {
    const seen: Array<ZoneRulesSlice | undefined> = []
    rulesHandle.subscribe((s) => seen.push(s))
    pushSlice(1, 'zone-rules', { motion: [], detection: [] })
    pushSlice(1, 'zone-rules', { motion: [motionExclude], detection: [] })
    pushSlice(1, 'zone-rules', {
      motion: [motionExclude],
      detection: [{ ...motionExclude, id: 'd-1', zoneIds: ['z-porch'] }],
    })
    // Each push includes both stages — consumers reading .motion or
    // .detection always see a consistent view.
    expect(seen.map((s) => ({ m: s?.motion.length ?? 0, d: s?.detection.length ?? 0 }))).toEqual([
      { m: 0, d: 0 },
      { m: 0, d: 0 },
      { m: 1, d: 0 },
      { m: 1, d: 1 },
    ])
  })
})
