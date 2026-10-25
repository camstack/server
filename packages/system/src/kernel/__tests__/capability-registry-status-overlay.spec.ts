/**
 * The D13 status overlay (D663, ruling S3): when a cap is CLAIMED on a device,
 * `getStatus` resolved through the registry answers the hub mirror's merged
 * slice — and every other method of the provider is left exactly as it was.
 *
 * Two shapes of native matter here. A plain in-process object is the easy one.
 * The HA feeder's native is built by the hub's `nativeFallback`
 * (`addon-registry.service.ts`): `new Proxy({}, { get })`, an EMPTY target whose
 * every property is a forwarding function. A spread copy of that is `{}` — it
 * loses `wakeForStream` and `reset`, and `requireDeviceScoped` then answers
 * NOT_IMPLEMENTED for every non-status method of a claimed cap. So the wrap is
 * a Proxy, and the HA-shaped test below is the one that would catch a spread.
 *
 * And a device whose claims are not yet KNOWN is never answered native: the
 * overlay says `unknown`, the wrapper resolves the claims when `getStatus` is
 * called, and a device that stays unknown is "not reported" (D315, D49).
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  batteryCapability,
  method,
  type CapabilityDefinition,
  type IScopedLogger,
  type StatusOverlay,
  type StatusOverlayAnswer,
} from '@camstack/types'
import { CapabilityRegistry } from '../capability-registry.js'

const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED_SLICE = { ...NATIVE, percentage: 90 }
const DEVICE = 7
const OTHER_DEVICE = 8
const UNCLAIMED: StatusOverlayAnswer = { kind: 'unclaimed' }

type Peek = (cap: string, id: number) => StatusOverlayAnswer

/** An overlay whose `resolve` answers what `peek` does — a device whose claims are already known. */
function knownOverlay(peek: Peek): StatusOverlay {
  return { peek, resolve: async (cap, id) => peek(cap, id) }
}

const claimBattery7 = (slice: Record<string, unknown> | null): StatusOverlay =>
  knownOverlay((cap, id) =>
    cap === 'battery' && id === DEVICE ? { kind: 'claimed', slice } : UNCLAIMED,
  )

type ForwardingNative = Record<string, (input: unknown) => Promise<unknown>>

function makeLogger(): IScopedLogger & { warn: ReturnType<typeof vi.fn> } {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  l.child.mockReturnValue(l)
  l.withTags.mockReturnValue(l)
  // Fake → interface: the mock's `child`/`withTags` return the same object,
  // which the interface's recursive type cannot state. Documented test boundary.
  return l as unknown as IScopedLogger & { warn: ReturnType<typeof vi.fn> }
}

function newRegistry(): { reg: CapabilityRegistry; logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger()
  const reg = new CapabilityRegistry(logger)
  reg.declareCapability(batteryCapability)
  reg.ready()
  return { reg, logger }
}

interface PlainNative {
  getStatus: (input?: unknown) => Promise<Record<string, unknown>>
  wakeForStream: (input?: unknown) => Promise<{ awoke: boolean; durationMs: number }>
}

function plainNative(): PlainNative {
  return {
    getStatus: async () => NATIVE,
    wakeForStream: async () => ({ awoke: true, durationMs: 5 }),
  }
}

/**
 * Exactly the shape `addon-registry.service.ts` returns from the nativeFallback:
 * an empty target, every string property a forwarding async function.
 */
function haShapedNative(calls: [string, unknown][]): ForwardingNative {
  return new Proxy<ForwardingNative>(
    {},
    {
      get: (_t, prop) =>
        typeof prop !== 'string'
          ? undefined
          : async (input: unknown) => {
              calls.push([prop, input])
              return prop === 'getStatus' ? NATIVE : { awoke: true, durationMs: 5 }
            },
    },
  )
}

describe('CapabilityRegistry — the claimed-status overlay (D13, S3)', () => {
  it('a claimed in-process cap answers getStatus from the overlay; other methods stay native', async () => {
    const { reg } = newRegistry()
    const native = plainNative()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', native)
    reg.setStatusOverlay(claimBattery7(OWNED_SLICE))

    const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
    expect(await p?.getStatus()).toEqual(OWNED_SLICE)
    expect(await p?.wakeForStream()).toEqual({ awoke: true, durationMs: 5 })
    expect(reg.getNativeProvider('battery', OTHER_DEVICE)).toBeNull()
  })

  it('the HA path: a native built by the nativeFallback PROXY keeps every method through the overlay (a spread would lose them)', async () => {
    const { reg } = newRegistry()
    const calls: [string, unknown][] = []
    reg.setNativeFallback((cap, id) =>
      cap === 'battery' && id === DEVICE ? haShapedNative(calls) : null,
    )
    reg.setStatusOverlay(claimBattery7(OWNED_SLICE))

    const p = reg.getNativeProvider<ForwardingNative>('battery', DEVICE)
    expect(await p?.['getStatus']?.({ deviceId: DEVICE })).toEqual(OWNED_SLICE)
    expect(await p?.['wakeForStream']?.({ deviceId: DEVICE, timeoutMs: 1000 })).toEqual({
      awoke: true,
      durationMs: 5,
    })
    // getStatus never reached the native; wakeForStream did, args intact.
    expect(calls).toEqual([['wakeForStream', { deviceId: DEVICE, timeoutMs: 1000 }]])
  })

  it('a HELD claim answers null — never the native value', async () => {
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', plainNative())
    reg.setStatusOverlay(claimBattery7(null))
    expect(await reg.getProviderForDevice<PlainNative>('battery', DEVICE)?.getStatus()).toBeNull()
  })

  it('unclaimed returns the very same provider object, after exactly one peek and no resolve', () => {
    const { reg } = newRegistry()
    const native = plainNative()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', native)
    const peek = vi.fn<Peek>(() => UNCLAIMED)
    const resolve = vi.fn(async () => UNCLAIMED)
    reg.setStatusOverlay({ peek, resolve })

    expect(reg.getNativeProvider('battery', DEVICE)).toBe(native)
    expect(reg.getProviderForDevice('battery', DEVICE)).toBe(native)
    // One in-memory check per resolve and nothing else — the old path, unchanged.
    expect(peek).toHaveBeenCalledTimes(2)
    expect(peek).toHaveBeenCalledWith('battery', DEVICE)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('with no overlay installed the resolvers are the old path (identity, no lookup)', async () => {
    const { reg } = newRegistry()
    const native = plainNative()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', native)
    expect(reg.getNativeProvider('battery', DEVICE)).toBe(native)
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual(UNCLAIMED)
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual(UNCLAIMED)
  })

  it('a claim released between resolve and call falls back to the native getStatus (call-time re-read)', async () => {
    const { reg } = newRegistry()
    const native = plainNative()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', native)
    let claimed = true
    reg.setStatusOverlay(
      knownOverlay((cap, id) =>
        claimed && cap === 'battery' && id === DEVICE
          ? { kind: 'claimed', slice: OWNED_SLICE }
          : UNCLAIMED,
      ),
    )
    const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
    claimed = false
    expect(await p?.getStatus()).toEqual(NATIVE)
  })

  it('uninstalling the overlay (setStatusOverlay(null)) hands getStatus back to the native, even on an already-resolved wrapper', async () => {
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', plainNative())
    reg.setStatusOverlay(claimBattery7(OWNED_SLICE))
    const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
    expect(await p?.getStatus()).toEqual(OWNED_SLICE)
    reg.setStatusOverlay(null)
    expect(await p?.getStatus()).toEqual(NATIVE)
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual(UNCLAIMED)
  })

  it('a device-bound SYSTEM provider (no native) is overlaid too — every resolver path, not only the native one', async () => {
    const { reg } = newRegistry()
    const wrapper = plainNative()
    reg.registerProvider('battery', 'virtual-battery', wrapper)
    reg.setStatusOverlay(claimBattery7(OWNED_SLICE))
    const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
    expect(await p?.getStatus()).toEqual(OWNED_SLICE)
    expect(await p?.wakeForStream()).toEqual({ awoke: true, durationMs: 5 })
    // The same wrapper, unclaimed for another device, is handed back as is.
    expect(reg.getProviderForDevice('battery', OTHER_DEVICE)).toBe(wrapper)
  })

  it('a class-instance native keeps its prototype methods and its `this`', async () => {
    class Native {
      private readonly wake = { awoke: true, durationMs: 5 }
      async getStatus(): Promise<Record<string, unknown>> {
        return NATIVE
      }
      async wakeForStream(): Promise<{ awoke: boolean; durationMs: number }> {
        return this.wake
      }
    }
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-reolink', new Native())
    reg.setStatusOverlay(claimBattery7(OWNED_SLICE))
    const p = reg.getProviderForDevice<Native>('battery', DEVICE)
    expect(await p?.getStatus()).toEqual(OWNED_SLICE)
    expect(await p?.wakeForStream()).toEqual({ awoke: true, durationMs: 5 })
  })
})

describe('a device whose claims are not yet KNOWN is never answered native (D315, D49)', () => {
  /** `peek` says unknown until `resolve` has run; `resolve` learns the given answer. */
  function lazyOverlay(learned: StatusOverlayAnswer): {
    overlay: StatusOverlay
    resolve: ReturnType<typeof vi.fn>
  } {
    let known: StatusOverlayAnswer | null = null
    const resolve = vi.fn(async (): Promise<StatusOverlayAnswer> => {
      known = learned
      return learned
    })
    return {
      overlay: { peek: () => known ?? { kind: 'unknown' }, resolve },
      resolve,
    }
  }

  it('unknown at resolve time ⇒ the provider is wrapped; getStatus resolves the claims first and answers the merge', async () => {
    const { reg } = newRegistry()
    const native = plainNative()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', native)
    const { overlay, resolve } = lazyOverlay({ kind: 'claimed', slice: OWNED_SLICE })
    reg.setStatusOverlay(overlay)

    const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
    expect(p).not.toBe(native)
    expect(resolve).not.toHaveBeenCalled() // nothing is read until getStatus is asked
    expect(await p?.getStatus()).toEqual(OWNED_SLICE)
    expect(resolve).toHaveBeenCalledWith('battery', DEVICE)
    // Every other method is the native's, untouched by the pending resolution.
    expect(await p?.wakeForStream()).toEqual({ awoke: true, durationMs: 5 })
  })

  it('unknown that resolves to UNCLAIMED answers the native — through the wrapper', async () => {
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', plainNative())
    reg.setStatusOverlay(lazyOverlay(UNCLAIMED).overlay)
    expect(await reg.getProviderForDevice<PlainNative>('battery', DEVICE)?.getStatus()).toEqual(
      NATIVE,
    )
  })

  it('unknown that STAYS unknown (the row cannot be read) is null — "not reported", never the native', async () => {
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', plainNative())
    reg.setStatusOverlay(lazyOverlay({ kind: 'unknown' }).overlay)
    expect(await reg.getProviderForDevice<PlainNative>('battery', DEVICE)?.getStatus()).toBeNull()
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({ kind: 'unknown' })
  })
})

describe('CapabilityRegistry.resolveClaimedStatus — parsed with the cap status schema', () => {
  it('parses the merged slice with `status.schema`: the runtime-only extra key is stripped (S4)', async () => {
    const { reg } = newRegistry()
    reg.setStatusOverlay(claimBattery7({ ...OWNED_SLICE, lastFetchedAt: 123 }))
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: OWNED_SLICE,
    })
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: OWNED_SLICE,
    })
  })

  it('the parse is paid on the getStatus CALL, never at resolve time (M-1)', async () => {
    const { reg } = newRegistry()
    reg.registerNativeProvider('battery', DEVICE, 'provider-homeassistant', plainNative())
    const schemaSpy = vi.spyOn(batteryCapability.status.schema, 'safeParse')
    try {
      reg.setStatusOverlay(claimBattery7(OWNED_SLICE))
      const p = reg.getProviderForDevice<PlainNative>('battery', DEVICE)
      await p?.wakeForStream()
      expect(schemaSpy).not.toHaveBeenCalled()
      await p?.getStatus()
      expect(schemaSpy).toHaveBeenCalledTimes(1)
    } finally {
      schemaSpy.mockRestore()
    }
  })

  it('an unparseable merged slice is `null` ("not reported", D315) with ONE tagged warn per (cap, device) transition', async () => {
    const { reg, logger } = newRegistry()
    let slice: Record<string, unknown> = { ...OWNED_SLICE, percentage: 'quite full' }
    reg.setStatusOverlay(
      knownOverlay((cap, id) =>
        cap === 'battery' && id === DEVICE ? { kind: 'claimed', slice } : UNCLAIMED,
      ),
    )

    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: null,
    })
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: null,
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({
      tags: { deviceId: DEVICE },
      meta: { capName: 'battery' },
    })

    // Back to a valid slice, then invalid again: a new transition, a new line.
    slice = OWNED_SLICE
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: OWNED_SLICE,
    })
    slice = { ...OWNED_SLICE, percentage: 'quite full' }
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: null,
    })
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('a held claim is `null` without a parse or a warn', async () => {
    const { reg, logger } = newRegistry()
    reg.setStatusOverlay(claimBattery7(null))
    expect(await reg.resolveClaimedStatus('battery', DEVICE)).toEqual({
      kind: 'claimed',
      slice: null,
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a claimed cap with no `status` block declared passes the merged slice through unparsed', async () => {
    const noStatusCap = {
      name: 'no-status',
      scope: 'device',
      mode: 'singleton',
      methods: { ping: method(z.object({ deviceId: z.number() }), z.literal('pong')) },
    } as const satisfies CapabilityDefinition
    const { reg } = newRegistry()
    reg.declareCapability(noStatusCap)
    reg.setStatusOverlay(
      knownOverlay((cap, id) =>
        cap === 'no-status' && id === DEVICE
          ? { kind: 'claimed', slice: { anything: 1 } }
          : UNCLAIMED,
      ),
    )
    expect(await reg.resolveClaimedStatus('no-status', DEVICE)).toEqual({
      kind: 'claimed',
      slice: { anything: 1 },
    })
  })
})
