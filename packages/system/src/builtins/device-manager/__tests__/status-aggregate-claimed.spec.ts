/**
 * `getDeviceStatusAggregate` for a device under a per-field claim (D663, S3):
 * the production wiring end to end — a REAL `DeviceStateMirror` (shared
 * harness), a REAL `CapabilityRegistry` whose native for the device is built
 * through the `nativeFallback` Proxy (the HA feeder's path), and the overlay
 * installed by `installClaimedStatusOverlay`, exactly as the device-manager
 * addon does at init.
 *
 * The second describe is the one CLAUDE.md warns about: a fixture that
 * pre-seeds the mirror cannot see what a claimed device answers BEFORE its
 * provider's first write — and that used to be the native value (D315, D49).
 * Those tests start from an UNSEEDED mirror and a row that carries the claim.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import {
  batteryCapability,
  ptzCapability,
  runtimeStatePolicyFor,
  type IScopedLogger,
  type StatusOverlayAnswer,
} from '@camstack/types'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import { installClaimedStatusOverlay } from '../claimed-status-overlay.js'
import { type AggregationDeps, getDeviceStatusAggregate } from '../device-aggregation.js'
import type { DeviceManagerSettings } from '../device-meta-store.js'
import type { ClaimsIndexView } from '../device-state-mirror.js'
import { OWNED_FIELDS_KEY } from '../field-ownership.js'
import { harness, loadedIndex, NOT_LOADED_INDEX } from './mirror-harness.js'

const NATIVE = { level: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED = {
  owner: 'blk-1',
  mode: 'replace' as const,
  fields: ['level'],
  values: { level: 90 },
}
const MERGED = { ...NATIVE, level: 90 }
const DEVICE = 7
const UNCLAIMED_DEVICE = 8

type ForwardingNative = Record<string, (input: unknown) => Promise<unknown>>

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface Fixture {
  readonly registry: CapabilityRegistry
  readonly deps: AggregationDeps
  readonly nativeCalls: [string, unknown][]
  readonly uninstall: () => void
  readonly h: ReturnType<typeof harness>
  /** Every row read the mirror made — the harness's door, spied. */
  readonly reads: MockInstance<DeviceManagerSettings['readDeviceRuntimeState']>
  /** The installed overlay's synchronous resolve-time question, asked directly. */
  readonly peek: (capName: string, deviceId: number) => StatusOverlayAnswer
  index: ClaimsIndexView
}

/** Registry + HA-shaped native + overlay over an UNSEEDED mirror; the index is what the spec says. */
function fixture(index: ClaimsIndexView = NOT_LOADED_INDEX): Fixture {
  const h = harness(runtimeStatePolicyFor)
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(batteryCapability)
  registry.ready()

  // The HA feeder's native: an EMPTY target whose every property forwards
  // (`addon-registry.service.ts`, the nativeFallback branch). Its getStatus
  // answers what the provider last wrote, which is the native slice.
  const nativeCalls: [string, unknown][] = []
  registry.setNativeFallback((cap, id) =>
    cap === 'battery' && (id === DEVICE || id === UNCLAIMED_DEVICE)
      ? new Proxy<ForwardingNative>(
          {},
          {
            get: (_t, prop) =>
              typeof prop !== 'string'
                ? undefined
                : async (input: unknown) => {
                    nativeCalls.push([prop, input])
                    return prop === 'getStatus' ? NATIVE : { awoke: true, durationMs: 5 }
                  },
          },
        )
      : null,
  )
  const setOverlay = vi.spyOn(registry, 'setStatusOverlay')
  const state: Fixture = {
    registry,
    nativeCalls,
    h,
    reads: vi.spyOn(h.settings, 'readDeviceRuntimeState'),
    index,
    uninstall: () => {},
    peek: (capName, deviceId) => {
      const installed = setOverlay.mock.calls[0]?.[0]
      if (!installed) throw new Error('the claimed-status overlay was not installed')
      return installed.peek(capName, deviceId)
    },
    // The aggregation deps are wide; this spec exercises exactly two members
    // of them — the same partial-deps boundary `status-aggregate-batch.spec.ts` documents.
    deps: { ctx: { logger }, capabilityRegistry: registry } as unknown as AggregationDeps,
  }
  const uninstall = installClaimedStatusOverlay(registry, {
    mirror: h.mirror,
    claimsIndex: () => state.index,
    settings: () => h.settings,
    logger,
  })
  return { ...state, uninstall }
}

const aggregate = (f: Fixture): Promise<Record<string, unknown | null>> =>
  getDeviceStatusAggregate(f.deps, { deviceId: DEVICE, caps: ['battery'] })

describe('getDeviceStatusAggregate under a replace claim, claims already known', () => {
  async function seededAndClaimed(): Promise<Fixture> {
    const f = fixture()
    f.h.mirror.seedMirror(DEVICE, { battery: NATIVE })
    expect(await f.h.mirror.claim(DEVICE, 'battery', OWNED, f.h.settings)).toEqual({
      ok: true,
      changed: true,
    })
    return f
  }

  it('shows the OWNED value for the claimed cap, and the native is never asked for it', async () => {
    const f = await seededAndClaimed()
    expect((await aggregate(f))['battery']).toEqual(MERGED)
    expect(f.nativeCalls).toEqual([])
  })

  it('follows the native for the fields the claim does not own', async () => {
    const f = await seededAndClaimed()
    f.h.mirror.applySingleCapUpdate(DEVICE, 'battery', {
      ...NATIVE,
      charging: 'solar',
      level: 3,
    })
    expect((await aggregate(f))['battery']).toEqual({
      ...NATIVE,
      charging: 'solar',
      level: 90,
    })
  })

  it('the same aggregate after release shows the native value', async () => {
    const f = await seededAndClaimed()
    await f.h.mirror.release(DEVICE, 'battery', OWNED.owner, f.h.settings)
    expect((await aggregate(f))['battery']).toEqual(NATIVE)
    expect(f.nativeCalls).toEqual([['getStatus', { deviceId: DEVICE }]])
  })

  it('every other method of the claimed cap still reaches the native through the same resolved provider', async () => {
    const f = await seededAndClaimed()
    const p = f.registry.getNativeProvider<ForwardingNative>('battery', DEVICE)
    expect(await p?.['wakeForStream']?.({ deviceId: DEVICE, timeoutMs: 1000 })).toEqual({
      awoke: true,
      durationMs: 5,
    })
    expect(f.nativeCalls).toEqual([['wakeForStream', { deviceId: DEVICE, timeoutMs: 1000 }]])
  })

  it('the uninstall the addon runs at shutdown hands getStatus back to the native', async () => {
    const f = await seededAndClaimed()
    f.uninstall()
    expect((await aggregate(f))['battery']).toEqual(NATIVE)
  })

  it('a seeded device with no claim takes the old path: the provider is handed back untouched', async () => {
    const f = await seededAndClaimed()
    f.h.mirror.seedMirror(UNCLAIMED_DEVICE, { battery: NATIVE })
    const native = { getStatus: async () => NATIVE }
    f.registry.registerNativeProvider('battery', UNCLAIMED_DEVICE, 'provider-reolink', native)
    expect(f.registry.getProviderForDevice('battery', UNCLAIMED_DEVICE)).toBe(native)
  })
})

describe('a claimed device whose row has NOT been read yet is never answered native (D315, D49)', () => {
  /** The row as the last boot left it: the native slice plus the standing claim. */
  const ROW_WITH_CLAIM = { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } }

  it('claims index NOT loaded: the row is read once, single-flight, and the aggregate shows the MERGED value', async () => {
    const f = fixture(NOT_LOADED_INDEX)
    f.h.rows.set(DEVICE, ROW_WITH_CLAIM)
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)

    const [a, b] = await Promise.all([aggregate(f), aggregate(f)])
    expect(a['battery']).toEqual(MERGED)
    expect(b['battery']).toEqual(MERGED)
    expect(f.reads).toHaveBeenCalledTimes(1)
    expect(f.nativeCalls).toEqual([])
    // Known now: the next resolve is the fast path — no wrapper for a seeded, unclaimed cap.
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(true)
  })

  it('claims index LOADED and naming the device: the row is read and the merge answers', async () => {
    const f = fixture(loadedIndex([DEVICE]))
    f.h.rows.set(DEVICE, ROW_WITH_CLAIM)
    expect((await aggregate(f))['battery']).toEqual(MERGED)
    expect(f.reads).toHaveBeenCalledTimes(1)
    expect(f.nativeCalls).toEqual([])
  })

  it('claims index LOADED and NOT naming the device: KNOWN unclaimed — no row read, the very same provider, the native answers', async () => {
    const f = fixture(loadedIndex([]))
    f.h.rows.set(DEVICE, ROW_WITH_CLAIM) // a stale row the index says nothing about is never consulted
    const native = { getStatus: async () => NATIVE }
    f.registry.registerNativeProvider('battery', UNCLAIMED_DEVICE, 'provider-reolink', native)
    expect(f.registry.getProviderForDevice('battery', UNCLAIMED_DEVICE)).toBe(native)
    expect((await aggregate(f))['battery']).toEqual(NATIVE)
    expect(f.reads).not.toHaveBeenCalled()
  })

  it('the row cannot be read: "not reported" (null), never the native — and the next call reads again', async () => {
    const f = fixture(NOT_LOADED_INDEX)
    f.h.rows.set(DEVICE, ROW_WITH_CLAIM)
    f.h.failReads.add(DEVICE)
    expect((await aggregate(f))['battery']).toBeNull()
    expect(f.nativeCalls).toEqual([])
    // The refusal is a named log line with the device tag (D391), once.
    expect(f.h.logs.filter((l) => l.level === 'warn')).toHaveLength(1)
    expect(f.h.logs[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE } })

    f.h.failReads.delete(DEVICE)
    expect((await aggregate(f))['battery']).toEqual(MERGED)
    expect(f.reads).toHaveBeenCalledTimes(2)
  })

  it('claims index LOADED and NOT naming the device, row UNREADABLE: the index is authoritative — native, no read, never null', async () => {
    // The vast majority of devices carry no claim: their getStatus must never
    // depend on a row read or on sqlite health (fix round 2 ruling).
    const f = fixture(loadedIndex([]))
    f.h.failReads.add(DEVICE)
    expect((await aggregate(f))['battery']).toEqual(NATIVE)
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.h.logs.filter((l) => l.level === 'warn')).toHaveLength(0)
    // The same device, asked as a native-provider object: the very same object, no wrapper.
    const native = { getStatus: async () => NATIVE }
    f.registry.registerNativeProvider('battery', UNCLAIMED_DEVICE, 'provider-reolink', native)
    f.h.failReads.add(UNCLAIMED_DEVICE)
    expect(f.registry.getProviderForDevice('battery', UNCLAIMED_DEVICE)).toBe(native)
  })

  it('the `unknown` → row-read → null path applies ONLY while the index is not loaded (the twin of the test above)', async () => {
    const f = fixture(NOT_LOADED_INDEX)
    f.h.failReads.add(DEVICE)
    expect((await aggregate(f))['battery']).toBeNull()
    expect(f.reads).toHaveBeenCalledTimes(1)
  })

  it('a device the loaded index does not name, resolved once, is marked seeded — the next peek is one lookup', async () => {
    const f = fixture(loadedIndex([]))
    expect(f.h.mirror.isSeeded(UNCLAIMED_DEVICE)).toBe(false)
    expect(f.peek('battery', UNCLAIMED_DEVICE)).toEqual({ kind: 'unclaimed' })
    expect(f.h.mirror.isSeeded(UNCLAIMED_DEVICE)).toBe(true)
    expect(f.reads).not.toHaveBeenCalled()
  })
})

describe('a row read in flight (a claim landing) — peek is synchronous and holds no promise (N-1, M-5)', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
  })

  it('a FAILING in-flight read while the loaded index clears the device: peek answers unknown, nothing escapes as an unhandled rejection', async () => {
    const f = fixture(loadedIndex([]))
    f.h.failReads.add(DEVICE)
    // A claim's row read in flight (what `mirror.claim` does first), doomed to fail.
    const inFlight = f.h.mirror
      .ensureSeeded(DEVICE, f.h.settings, NOT_LOADED_INDEX)
      .catch(() => 'failed')
    expect(f.reads).toHaveBeenCalledTimes(1)
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)

    // The status aggregate resolves the provider NOW: the sync peek must not
    // touch the in-flight promise and must not call the device unclaimed.
    expect(f.peek('battery', DEVICE)).toEqual({ kind: 'unknown' })
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)
    expect(await inFlight).toBe('failed')
    await new Promise((r) => setImmediate(r))
    expect(rejections).toEqual([])

    // The read settled (failed): the index now vouches — known unclaimed, no read.
    f.reads.mockClear()
    expect(f.peek('battery', DEVICE)).toEqual({ kind: 'unclaimed' })
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(true)
    expect(f.reads).not.toHaveBeenCalled()
  })

  it('a claim landing during a getStatus: unknown and pending while the row read is in flight, never a native call; the merge once it has landed', async () => {
    const f = fixture(loadedIndex([]))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    // The row as a NEW claim finds it: the native only (a row already carrying
    // the claim would make `claim` answer `changed: false`, truthfully).
    f.reads.mockImplementationOnce(async () => {
      await gate
      return { battery: NATIVE }
    })
    // The composer's claim: its row read is now in flight.
    const claiming = f.h.mirror.claim(DEVICE, 'battery', OWNED, f.h.settings)
    await new Promise((r) => setImmediate(r))
    expect(f.reads).toHaveBeenCalledTimes(1)
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)

    let settled = false
    const pending = aggregate(f).then((v) => {
      settled = true
      return v
    })
    await new Promise((r) => setImmediate(r))
    // The ruled scope (M-5): while the read is in flight the device is unknown,
    // not seeded, the aggregate has not answered and the native was never asked.
    expect(f.peek('battery', DEVICE)).toEqual({ kind: 'unknown' })
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)
    expect(settled).toBe(false)
    expect(f.nativeCalls).toEqual([])

    release()
    expect(await claiming).toEqual({ ok: true, changed: true })
    // The read settled a few microtasks before the claim applied its view — the
    // aggregate that was waiting on it answers in that landing turn (native or
    // merged is the moment's truth); every aggregate after the claim landed is
    // the merge, and the read was paid once for both.
    await pending
    expect((await aggregate(f))['battery']).toEqual(MERGED)
    expect(f.reads).toHaveBeenCalledTimes(1)
  })

  it('N concurrent polls of one device under a not-loaded index cost ONE row read, and the fleet-level fact is logged once', async () => {
    const f = fixture(NOT_LOADED_INDEX)
    f.h.rows.set(DEVICE, { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } })
    const polls = await Promise.all(Array.from({ length: 8 }, () => aggregate(f)))
    for (const p of polls) expect(p['battery']).toEqual(MERGED)
    expect(f.reads).toHaveBeenCalledTimes(1)
    const infoLine = f.deps.ctx.logger.info as ReturnType<typeof vi.fn>
    const noted = infoLine.mock.calls.filter((c) =>
      String(c[0]).includes('claims index not loaded'),
    )
    expect(noted).toHaveLength(1)
    expect(noted[0]?.[1]).toMatchObject({ tags: { deviceId: DEVICE } })
  })
})

describe('a cap that can never be claimed never asks for the claims (final review M-2)', () => {
  it('ptz (no runtimeState) on an unseeded device, index not loaded, row unreadable: the native, no row read, never a false "unknown"', async () => {
    const f = fixture(NOT_LOADED_INDEX)
    f.registry.declareCapability(ptzCapability)
    f.h.failReads.add(DEVICE)
    const native = { getStatus: async () => ({ moving: false }) }
    f.registry.registerNativeProvider('ptz', DEVICE, 'provider-reolink', native)

    // Resolve-time: the very same object, no wrapper.
    expect(f.registry.getProviderForDevice('ptz', DEVICE)).toBe(native)
    // Call-time (the three transport entries ask this): known unclaimed, not unknown.
    expect(await f.registry.resolveClaimedStatus('ptz', DEVICE)).toEqual({ kind: 'unclaimed' })
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.h.mirror.isSeeded(DEVICE)).toBe(false)
  })
})
