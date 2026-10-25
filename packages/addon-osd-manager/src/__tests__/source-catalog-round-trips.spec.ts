/**
 * `getSourceCatalog` — one round trip for the fleet's bindings, not one per
 * device, and the SAME catalog either way.
 *
 * Opening a slot editor calls this once (`CameraOsdRow` →
 * `useOsdManagerGetSourceCatalog`). It walked every device in the cluster
 * issuing `deviceManager.getBindings.query({ deviceId })` per row: on the live
 * hub 2026-08-30 that is **1 + 1 019 sequential cross-process cap calls**, each
 * a store-backed resolve, behind a plain operator action. `getBindingsBatch`
 * answers the whole set in one — same resolver, same per-device shape, ids
 * deduped, a device with nothing bound answering `entries: []` rather than
 * dropping out (`device-manager.cap.ts`).
 *
 * ## What is NOT done here, deliberately
 *
 * The device LIST is not narrowed to cameras. `sourceOptionsFor` exists to
 * offer "every bindable value across the cluster" and `OsdManagerDeps.listDevices`
 * says in as many words that a slot may render state from ANY device — binding a
 * sensor's `pm25` onto a camera's overlay is the feature. An `isCamera: true`
 * filter here would return 30 rows instead of 1 019 and delete the picker's
 * reason to exist. Fewer round trips, never fewer answers.
 *
 * Counting: a `Proxy` over the WHOLE dependency surface, so the asserted total
 * covers every seam the manager has — including one that does not exist yet. A
 * per-device fan-out that reappears under another name still fails these tests.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { BindingsHandle, OsdDeviceBindings } from '../bindings-store.js'
import { EMPTY_TEMPLATES } from '../templates-store.js'
import { EMPTY_BINDINGS } from '../bindings-store.js'
import type { BoundIndexHandle, OsdBoundIndex } from '../bound-index.js'
import { OsdManager, type OsdDeviceSummary, type OsdManagerDeps } from '../osd-manager.js'
import { sourceOptionsFor } from '../source-catalog.js'

const CAMERA = 101

/** The live hub's shape in miniature: 30 cameras among 200 devices, and the
 *  bindable state lives on the OTHER 170. */
const FLEET_SIZE = 200
const CAMERA_COUNT = 30

function noopLogger(): IScopedLogger {
  const self: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => self,
    withTags: () => self,
  }
  return self
}

function fleet(): readonly OsdDeviceSummary[] {
  return Array.from({ length: FLEET_SIZE }, (_, i) => ({
    id: CAMERA + i,
    name: i < CAMERA_COUNT ? `Camera ${i}` : `Sensor ${i}`,
  }))
}

/** Caps a device publishes. Cameras carry a temperature reading; everything
 *  else carries `air-quality-sensor`, which is only bindable if non-cameras
 *  are asked. Both are OSD-whitelisted (motion / broker are not). */
function capsFor(deviceId: number): readonly string[] {
  return deviceId - CAMERA < CAMERA_COUNT ? ['temperature-sensor'] : ['air-quality-sensor']
}

interface CatalogHarness {
  readonly manager: OsdManager
  /** Every dependency invocation since construction, keyed by dep name. */
  readonly calls: () => Readonly<Record<string, number>>
  /** Total invocations across EVERY dependency — the number that catches a
   *  per-device fan-out that moved to a door nobody named. */
  readonly totalCalls: () => number
}

/**
 * Count EVERY call through the dependency surface, whatever it is called.
 *
 * A counter wired to the one method under suspicion catches the loop it was
 * written for and nothing else. This `Proxy` has no list, so a per-device read
 * that reappears on `readDeviceSnapshot`, on `bindings`, or on a dep that does
 * not exist yet still lands in the total these tests assert on.
 */
function countingDeps(deps: OsdManagerDeps, tally: Record<string, number>): OsdManagerDeps {
  return new Proxy(deps, {
    get(target, prop, receiver) {
      const member: unknown = Reflect.get(target, prop, receiver)
      if (typeof member !== 'function') return member
      const name = String(prop)
      return (...args: readonly unknown[]): unknown => {
        tally[name] = (tally[name] ?? 0) + 1
        return Reflect.apply(member, target, args)
      }
    },
  })
}

function makeCatalogHarness(overrides: Partial<OsdManagerDeps> = {}): CatalogHarness {
  const stored = new Map<number, OsdDeviceBindings>()
  const bindings = (deviceId: number): BindingsHandle => ({
    get: async () => stored.get(deviceId) ?? EMPTY_BINDINGS,
    set: async (next) => {
      stored.set(deviceId, next)
    },
    update: async (fn) => {
      stored.set(deviceId, fn(stored.get(deviceId) ?? EMPTY_BINDINGS))
    },
  })
  let boundIndexValue: OsdBoundIndex = null
  const boundIndex: BoundIndexHandle = {
    get: async () => boundIndexValue,
    set: async (next) => {
      boundIndexValue = next === null ? null : [...next]
    },
  }

  const tally: Record<string, number> = {}
  const manager = new OsdManager(
    countingDeps(
      {
        logger: noopLogger(),
        readOsdStatus: async () => null,
        writeOverlay: async () => undefined,
        readDeviceSnapshot: async () => ({}),
        listDevices: async () => fleet(),
        listCameras: async () => fleet().slice(0, CAMERA_COUNT),
        listDeviceCapsBatch: async (deviceIds) => new Map(deviceIds.map((id) => [id, capsFor(id)])),
        readLatestRecognitions: async () => ({}),
        bindings,
        boundIndex,
        templates: {
          get: async () => EMPTY_TEMPLATES,
          set: async () => undefined,
        },
        ...overrides,
      },
      tally,
    ),
  )

  return {
    manager,
    calls: () => ({ ...tally }),
    totalCalls: () => Object.values(tally).reduce((a, b) => a + b, 0),
  }
}

describe('OsdManager.getSourceCatalog', () => {
  it('asks for the fleet’s bindings ONCE, not once per device', async () => {
    const h = makeCatalogHarness()
    await h.manager.getSourceCatalog({ deviceId: CAMERA })
    expect(h.calls()['listDeviceCapsBatch']).toBe(1)
    // The whole dependency surface, not just the door under suspicion: the
    // catalog is one device listing plus one bindings question and nothing
    // else, whatever a future fan-out might be called.
    expect(h.totalCalls()).toBe(2)
  })

  it('still offers the state of devices that are not cameras', async () => {
    // The narrowing this fix refuses. `air-quality-sensor` lives on the 170
    // non-camera rows; an `isCamera: true` list would silently drop every one
    // of them and the picker would offer nothing but motion.
    const h = makeCatalogHarness()
    const { sources } = await h.manager.getSourceCatalog({ deviceId: CAMERA })
    const capNames = new Set(sources.map((s) => s.capName))
    expect(capNames.has('air-quality-sensor')).toBe(true)
    expect(new Set(sources.map((s) => s.deviceId)).size).toBe(FLEET_SIZE)
  })

  it('produces exactly the catalog the per-device walk produced', async () => {
    // Parity against an INDEPENDENTLY built map — every device, its own caps,
    // exactly what one `listDeviceCaps` per row yielded. Same options, same
    // order, so this is a cost fix and not a second catalog that can drift.
    const h = makeCatalogHarness()
    const { sources } = await h.manager.getSourceCatalog({ deviceId: CAMERA })
    const perDeviceMap = new Map(fleet().map((d) => [d.id, capsFor(d.id)]))
    expect(sources).toEqual(sourceOptionsFor(CAMERA, fleet(), perDeviceMap))
  })

  it('answers with an empty catalog — never a crash — when the bindings read fails', async () => {
    // The per-device loop caught each failure and omitted that device; with
    // every device failing, the catalog was empty. One batch has no partial
    // failure mode, so the whole-batch failure must land on the same answer.
    const h = makeCatalogHarness({
      listDeviceCapsBatch: async () => {
        throw new Error('device-manager unreachable')
      },
    })
    await expect(h.manager.getSourceCatalog({ deviceId: CAMERA })).resolves.toEqual({ sources: [] })
  })

  it('asks about every device it listed, so no row is silently skipped', async () => {
    const asked: number[][] = []
    const h = makeCatalogHarness({
      listDeviceCapsBatch: async (deviceIds) => {
        asked.push([...deviceIds])
        return new Map(deviceIds.map((id) => [id, capsFor(id)]))
      },
    })
    await h.manager.getSourceCatalog({ deviceId: CAMERA })
    expect(asked).toEqual([fleet().map((d) => d.id)])
  })
})
