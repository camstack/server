/**
 * DeviceProxy end-to-end flow for zones.
 *
 * Wires `createDeviceProxy` against a fake tRPC client + a shared
 * mirror source so both the cap-method bag (`device.zones?.*`,
 * `device.zoneRules?.*`) AND the reactive state slots
 * (`device.state.zones.value`, `device.state.zoneRules.value`,
 * `device.state.zoneAnalytics.value`) round-trip through one
 * canonical surface — same wiring the admin UI's `useDeviceProxy`
 * hook produces in the browser.
 *
 * The spec proves the consumer pattern motion-wasm + analytics +
 * pipeline-executor + the admin UI all rely on:
 *   - cap-method dispatch goes through `<cap>.<method>.{query|mutate}`
 *     with deviceId + nodeId merged in by the proxy
 *   - state slot subscribers seed with the current cached value
 *   - mirror pushes fan out to every active subscriber
 *   - reading `.value` after a push returns the latest slice sync
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Zone, ZoneRule } from '../../capabilities/index.js'
import type { DeviceBinding } from '../device-binding.js'
import { createDeviceProxy } from '../../generated/device-proxy.js'
import { createMirrorSource } from '../device-state-handle.js'
import type { AddonApi } from '../../generated/addon-api.js'

// ── Test fixtures ────────────────────────────────────────────────────

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
const detectionInclude: ZoneRule = {
  id: 'd-1',
  zoneIds: ['z-porch'],
  mode: 'include',
  classFilter: ['person'],
  enabled: true,
}

// ── Fake api + mirror plumbing ───────────────────────────────────────

interface MutateCall {
  capName: string
  methodName: string
  input: Record<string, unknown>
}

function makeFakeWiring(deviceId: number) {
  const mirror = new Map<number, Map<string, unknown>>()
  const listeners = new Map<string, Set<(slice: unknown | undefined) => void>>()
  const calls: MutateCall[] = []

  // Mirror source feeds the SliceHandle reads + watches.
  const source = createMirrorSource(mirror, listeners)

  // Cap method bag — for every cap.method we satisfy the codegen's
  // `<cap>.<method>.{query|mutate|subscribe}` shape with a recording
  // mock that returns void or a fixed payload.
  const handler = {
    get(_target: unknown, capName: string) {
      return new Proxy(
        {},
        {
          get(_t, methodName: string) {
            return {
              query: vi.fn(async (input: Record<string, unknown>) => {
                calls.push({ capName, methodName, input })
                return undefined
              }),
              mutate: vi.fn(async (input: Record<string, unknown>) => {
                calls.push({ capName, methodName, input })
                return undefined
              }),
              subscribe: vi.fn(),
            }
          },
        },
      )
    },
  }
  const api = new Proxy({}, handler) as unknown as AddonApi

  // Helper: push a slice into the mirror + fan out to any active
  // listeners — replays what the kernel does on every setCapSlice.
  const pushSlice = (capName: string, slice: Record<string, unknown>): void => {
    let perCap = mirror.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      mirror.set(deviceId, perCap)
    }
    perCap.set(capName, slice)
    const set = listeners.get(`${deviceId}:${capName}`)
    if (set) for (const cb of set) cb(slice)
  }

  return { mirror, listeners, api, source, calls, pushSlice }
}

// Minimal binding — every cap's entry just needs capName + providerNodeId.
const binding: DeviceBinding = {
  deviceId: 1,
  entries: [
    { capName: 'zones', providerNodeId: 'hub' },
    { capName: 'zone-rules', providerNodeId: 'hub' },
    { capName: 'zone-analytics', providerNodeId: 'hub' },
  ],
} as unknown as DeviceBinding

describe('DeviceProxy zones flow', () => {
  let wiring: ReturnType<typeof makeFakeWiring>
  let dev: ReturnType<typeof createDeviceProxy>

  beforeEach(() => {
    wiring = makeFakeWiring(1)
    dev = createDeviceProxy(wiring.api, binding, { stateSource: wiring.source })
  })

  it('cap method bag — addZone routes through zones.addZone.mutate with deviceId injected', async () => {
    await dev.zones?.addZone({ zone: driveway })
    expect(wiring.calls).toHaveLength(1)
    expect(wiring.calls[0]!.capName).toBe('zones')
    expect(wiring.calls[0]!.methodName).toBe('addZone')
    expect(wiring.calls[0]!.input).toMatchObject({
      deviceId: 1,
      nodeId: 'hub',
      zone: driveway,
    })
  })

  it('cap method bag — zoneRules.setRules carries stage + rules', async () => {
    await dev.zoneRules?.setRules({ stage: 'detection', rules: [detectionInclude] })
    // Cap key in the api proxy is camel-cased ('zoneRules') even
    // though the cap.name + binding entry use kebab-case ('zone-rules').
    expect(wiring.calls[0]!.capName).toBe('zoneRules')
    expect(wiring.calls[0]!.methodName).toBe('setRules')
    expect(wiring.calls[0]!.input).toMatchObject({
      deviceId: 1,
      stage: 'detection',
      rules: [detectionInclude],
    })
  })

  it('reactive state — dev.state.zones.value updates when mirror pushes', () => {
    const seen: Array<{ zones: readonly Zone[] } | undefined> = []
    dev.state.zones.subscribe((s) => seen.push(s))
    expect(seen).toEqual([undefined]) // seed
    wiring.pushSlice('zones', { zones: [driveway] })
    expect(dev.state.zones.value).toEqual({ zones: [driveway] })
    expect(seen[seen.length - 1]).toEqual({ zones: [driveway] })
    wiring.pushSlice('zones', { zones: [driveway, porch] })
    expect(dev.state.zones.value?.zones.map((z) => z.id)).toEqual(['z-drv', 'z-porch'])
  })

  it('reactive state — dev.state.zoneRules carries both stages atomically', () => {
    const seen: Array<{ motion: readonly ZoneRule[]; detection: readonly ZoneRule[] } | undefined> =
      []
    dev.state.zoneRules.subscribe((s) => seen.push(s))
    wiring.pushSlice('zone-rules', { motion: [motionExclude], detection: [] })
    expect(dev.state.zoneRules.value?.motion).toEqual([motionExclude])
    expect(dev.state.zoneRules.value?.detection).toEqual([])
    wiring.pushSlice('zone-rules', { motion: [motionExclude], detection: [detectionInclude] })
    expect(dev.state.zoneRules.value?.detection).toEqual([detectionInclude])
    // Both stages always come together — never half-updated.
    expect(seen[seen.length - 1]).toEqual({
      motion: [motionExclude],
      detection: [detectionInclude],
    })
  })

  it('reactive state — dev.state.zoneAnalytics surfaces snapshots', () => {
    const seen: Array<unknown> = []
    dev.state.zoneAnalytics.subscribe((s) => seen.push(s))
    const snap = {
      ts: 1_000,
      frameWidth: 1920,
      frameHeight: 1080,
      zones: [],
      frame: { totalObjects: 3, byClass: { person: 2, car: 1 } },
      unzoned: { totalObjects: 0, byClass: {} },
    }
    wiring.pushSlice('zone-analytics', snap)
    expect(dev.state.zoneAnalytics.value).toEqual(snap)
  })

  it('unsubscribe stops further callbacks but mirror cache stays live', () => {
    const seen: Array<unknown> = []
    const stop = dev.state.zones.subscribe((s) => seen.push(s))
    wiring.pushSlice('zones', { zones: [driveway] })
    expect(seen).toHaveLength(2) // seed + push
    stop()
    wiring.pushSlice('zones', { zones: [driveway, porch] })
    expect(seen).toHaveLength(2) // unchanged
    // .value still reflects the latest push — mirror is the source of truth.
    expect(dev.state.zones.value?.zones).toHaveLength(2)
  })

  it('multiple subscribers all see the same updates', () => {
    const a: Array<unknown> = []
    const b: Array<unknown> = []
    dev.state.zoneRules.subscribe((s) => a.push(s))
    dev.state.zoneRules.subscribe((s) => b.push(s))
    wiring.pushSlice('zone-rules', { motion: [], detection: [detectionInclude] })
    expect(a.length).toBe(2)
    expect(b.length).toBe(2)
    expect(a[1]).toEqual({ motion: [], detection: [detectionInclude] })
    expect(b[1]).toEqual({ motion: [], detection: [detectionInclude] })
  })
})
