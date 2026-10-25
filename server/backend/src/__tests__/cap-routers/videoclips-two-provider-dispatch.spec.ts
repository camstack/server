/**
 * The gate spec for the external-videoclips line (design
 * `docs/design/2026-08-17-videoclips-implementation.md` § 2.3 and
 * `docs/design/2026-09-20-external-videoclips.md` § 8 P7; D549 decisions 2–3,
 * D552, D554).
 *
 * TWO providers of the same `scope:'device'` + `kind:'wrapper'` capability must
 * both be reachable, PER CAMERA — and since slice 6 they are reachable AT THE
 * SAME TIME on one camera: `videoclips` is `mode: 'collection'`, so a camera's
 * providers are SOURCES listed beside each other, never one substituted for
 * another (the staging the operator rejected: *"voglio poter decidere quali
 * clips vedere senza perdere niente"*).
 *
 * Two mount defects are pinned here, and they are different:
 *
 *  - Before the `device-scoped` mount (slice 1, D552), `videoclips` resolved
 *    `reg.getSingleton('videoclips')`: the per-device binding persisted,
 *    `getBindings` reported it, and every camera got the GLOBAL active
 *    provider anyway.
 *  - `mode: 'collection'` is checked BEFORE the device-wrapper rule in
 *    `resolveCapMount`, so slice 6 would have flipped the cap onto the GLOBAL
 *    collection mount — every provider fanned for every caller, the per-device
 *    view never consulted. D554 reorders the derivation; the per-camera
 *    assertions below go red if either half is reverted.
 *
 * Everything here is production wiring — the REAL `CapabilityRegistry`, the
 * REAL `createCapRouterServices` switch from `cap-router-runtime.ts`, the REAL
 * `buildCapRouters`. The only doubles are the providers and a moleculer
 * stand-in that never resolves a remote node (this hub owns both devices).
 * The router builder does not re-validate output, so this spec is what pins
 * the dispatch and the merge.
 */

import { CAP_METHOD_NOT_IMPLEMENTED, CapabilityRegistry } from '@camstack/system'
import type { Clip, ClipSource, IScopedLogger } from '@camstack/types'
import { deviceManagerCapability, videoclipsCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildRuntimeCapRouters, type CapProxyProvider } from '../../api/trpc/cap-router-runtime.js'
import { requireDeviceCollection } from '../../api/trpc/device-collection-dispatch.js'
import { type CreateCallerCapableRouter, makeCtx } from './harness.js'

const ANALYTICS_ADDON = 'addon-post-analysis'
const NATIVE_ADDON = 'addon-provider-reolink'

const ANALYTICS_SOURCE = 'analytics'
const NATIVE_SOURCE = 'native:reolink:onboard'

/** The camera the operator narrowed to one source. */
const FILTERED_DEVICE_ID = 101
/** A camera with no filter — it must see every source it has. */
const UNFILTERED_DEVICE_ID = 102

interface LoggerCall {
  readonly message: string
  readonly meta: unknown
}

interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly warns: LoggerCall[]
}

function makeLogger(): RecordingLogger {
  const warns: LoggerCall[] = []
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      warns.push({ message, meta })
    }),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return { logger, warns }
}

function clipAt(source: string, startMs: number, suffix: string): Clip {
  return {
    id: `${source}:${startMs}:${suffix}`,
    source,
    kind: 'native',
    timeRange: { startMs, endMs: startMs + 30_000 },
  }
}

interface ProviderDouble {
  readonly listClips: (input: { deviceId: number }) => Promise<readonly Clip[]>
  readonly listSources: (input: { deviceId: number }) => Promise<readonly ClipSource[]>
  readonly getClipPlayback: (input: { deviceId: number; clipId: string }) => Promise<{
    readonly playbackUrl: string
  }>
  /** Optional on the cap; a double that does not serve it refuses with the marker. */
  readonly getPlaybackOptions: (input: { deviceId: number }) => Promise<unknown>
}

interface ProviderOptions {
  readonly clips?: readonly Clip[]
  readonly sources?: readonly ClipSource[]
  /** Reject every call with this message — the source that cannot answer. */
  readonly failWith?: string
  /** Count how often each method was reached. */
  readonly calls?: Record<string, number>
  /**
   * Which REGISTRATION this double is — stamped into `getClipPlayback`'s
   * answer so a test can tell three registrations of ONE source apart.
   */
  readonly registration?: string
  /**
   * Serve `getPlaybackOptions` as a FORKED provider would: the method exists
   * (a UDS proxy fabricates a callable for every property) and the child
   * refuses it by name because the cap declares it `optionalMethod`.
   */
  readonly optionalRefusal?: boolean
}

function makeProvider(source: string, options: ProviderOptions = {}): ProviderDouble {
  const count = (method: string): void => {
    if (options.calls) options.calls[method] = (options.calls[method] ?? 0) + 1
  }
  const refuse = async (): Promise<never> => {
    throw new Error(options.failWith ?? 'unreachable')
  }
  return {
    listClips: async (_input) => {
      count('listClips')
      if (options.failWith !== undefined) return refuse()
      return options.clips ?? [clipAt(source, 1_758_000_000_000, 'a')]
    },
    listSources: async (_input) => {
      count('listSources')
      if (options.failWith !== undefined) return refuse()
      return options.sources ?? [{ source, label: source, availability: { state: 'ok' } }]
    },
    getPlaybackOptions: async (_input) => {
      count('getPlaybackOptions')
      if (options.optionalRefusal === true) {
        throw new Error(
          `${CAP_METHOD_NOT_IMPLEMENTED}: 'videoclips.getPlaybackOptions' is declared optional and this provider does not serve it`,
        )
      }
      return { transport: 'archive', seek: 'random', stepBack: true, scrub: true, rates: [1] }
    },
    getClipPlayback: async (input) => {
      count('getClipPlayback')
      if (options.failWith !== undefined) return refuse()
      return {
        playbackUrl: `${options.registration ?? source}://${input.clipId}`,
      }
    },
  }
}

interface RegistryOptions {
  /** Register the native provider alongside the default analytics one. */
  readonly withNative?: boolean
  /**
   * Per-device BINDINGS — what `deviceManager.getBindings` answers, which is
   * what says a provider serves a camera (D554 amended). Omitted entirely
   * means no device manager, which is the fail-open path every test above the
   * binding block deliberately takes.
   */
  readonly bindings?: Readonly<Record<number, readonly string[]>>
  readonly analytics?: ProviderOptions
  readonly native?: ProviderOptions
}

function makeRegistry(options: RegistryOptions, logger: IScopedLogger): CapabilityRegistry {
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(videoclipsCapability)
  registry.registerProvider(
    'videoclips',
    ANALYTICS_ADDON,
    makeProvider(ANALYTICS_SOURCE, options.analytics ?? {}),
  )
  if (options.withNative === true) {
    registry.registerProvider(
      'videoclips',
      NATIVE_ADDON,
      makeProvider(NATIVE_SOURCE, options.native ?? {}),
    )
  }
  const bindings = options.bindings
  if (bindings !== undefined) {
    registry.declareCapability({
      ...deviceManagerCapability,
      exposesDeviceSettings: false,
      methods: {},
    })
    registry.registerProvider('device-manager', 'device-manager', {
      getBindings: async (input: { deviceId: number }) => ({
        deviceId: input.deviceId,
        entries: (bindings[input.deviceId] ?? []).map((providerAddonId) => ({
          capName: 'videoclips',
          kind: 'wrapped' as const,
          providerAddonId,
          providerNodeId: 'hub',
          nativeAddonId: '',
        })),
      }),
    })
  }
  registry.ready()
  return registry
}

/** Moleculer stand-in: no node is remote here, so nothing resolves. */
const noRemoteNodes: CapProxyProvider = {
  createCapabilityProxy: () => null,
}

type Caller = Record<string, (input?: unknown) => unknown>

/**
 * Build the LIVE `videoclips` router and take an admin caller on it. The one
 * boundary assertion is the same documented seam `motion-device-native-route`
 * and `harness.ts` use: `buildRuntimeCapRouters` returns
 * `Record<string, unknown>` because the AppRouter TYPE is codegen-derived,
 * so the router value is narrowed here and nowhere else.
 */
function videoclipsCaller(registry: CapabilityRegistry, logger?: IScopedLogger): Caller {
  const routers = buildRuntimeCapRouters({
    capabilityRegistry: registry,
    moleculer: noRemoteNodes,
    serverProviders: {},
    ...(logger ? { logger } : {}),
  })
  const router = routers['videoclips']
  if (router === undefined) throw new Error('no router built for cap "videoclips"')
  return (router as CreateCallerCapableRouter).createCaller(makeCtx('admin'))
}

/** Read a string field off each returned row without trusting the wire shape. */
function fieldOf(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue
    const v: unknown = Reflect.get(row, field)
    if (typeof v === 'string') out.push(v)
  }
  return out
}

function idsOf(value: unknown): readonly string[] {
  return fieldOf(value, 'id')
}

function sourcesOf(value: unknown): readonly string[] {
  return fieldOf(value, 'source')
}

/** Read `playbackUrl` off the answer, the same way. */
function playbackUrlOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const url: unknown = Reflect.get(value, 'playbackUrl')
  return typeof url === 'string' ? url : null
}

/** The `availability.state` of each `listSources` row, in order. */
function statesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue
    const availability: unknown = Reflect.get(row, 'availability')
    if (availability === null || typeof availability !== 'object') continue
    const state: unknown = Reflect.get(availability, 'state')
    if (typeof state === 'string') out.push(state)
  }
  return out
}

const WINDOW = { since: 1_758_000_000_000, until: 1_758_000_100_000 }

async function listClips(caller: Caller, deviceId: number): Promise<unknown> {
  return await caller['listClips']?.({ deviceId, ...WINDOW })
}

/** `listClips` through the router, naming the provider the cap now requires. */
async function listClipsFrom(caller: Caller, deviceId: number, provider: string): Promise<unknown> {
  return await caller['listClips']?.({ deviceId, ...WINDOW, provider })
}

/**
 * The dispatcher ITSELF, with no input schema in front of it.
 *
 * `videoclips.listClips` can no longer reach the fan-out through the router —
 * `provider` is required (D554 amended) — but the fan-out, the isolation of a failing
 * source and the newest-first merge are the DISPATCHER's rules, inherited by
 * every device-scoped collection cap, and `listSources` still takes them on
 * every two-source camera. They are pinned here against the real
 * `requireDeviceCollection` over the real registry, using the cap's array
 * method for its shape, rather than deleted with the one route that stopped
 * using them.
 */
type CollectionDispatcher = NonNullable<ReturnType<typeof requireDeviceCollection>>

function collectionDispatcher(
  registry: CapabilityRegistry,
  logger: IScopedLogger,
): CollectionDispatcher {
  const dispatcher = requireDeviceCollection(registry, 'videoclips', logger)
  if (dispatcher === null) throw new Error('no collection dispatcher for "videoclips"')
  return dispatcher
}

async function fanOutClips(
  registry: CapabilityRegistry,
  logger: IScopedLogger,
  deviceId: number,
): Promise<unknown> {
  return await collectionDispatcher(registry, logger)['listClips']?.({ deviceId, ...WINDOW })
}

async function listSources(caller: Caller, deviceId: number): Promise<unknown> {
  return await caller['listSources']?.({ deviceId })
}

// ── The per-device mount (D552) in its collection form (D554) ─────────

describe('videoclips — the sources are resolved PER DEVICE', () => {
  const PER_CAMERA_BINDINGS = {
    [FILTERED_DEVICE_ID]: [NATIVE_ADDON],
    [UNFILTERED_DEVICE_ID]: [ANALYTICS_ADDON, NATIVE_ADDON],
  }

  // Asked through `listSources`, which is the method that enumerates a
  // device's sources and the only one that still fans out (`listClips` names
  // ONE provider, D554 amended). The claim is unchanged: the sources are the DEVICE's.
  it('a camera bound to one provider gets only that one', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(
      makeRegistry({ withNative: true, bindings: PER_CAMERA_BINDINGS }, logger),
      logger,
    )
    expect(sourcesOf(await listSources(caller, FILTERED_DEVICE_ID))).toEqual([NATIVE_SOURCE])
  })

  it('another camera, in the SAME build, still sees every source it has', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(
      makeRegistry({ withNative: true, bindings: PER_CAMERA_BINDINGS }, logger),
      logger,
    )
    expect([...sourcesOf(await listSources(caller, UNFILTERED_DEVICE_ID))].sort()).toEqual(
      [ANALYTICS_SOURCE, NATIVE_SOURCE].sort(),
    )
  })

  it('a camera with no provider at all is refused by name, not answered empty', async () => {
    const { logger } = makeLogger()
    const registry = new CapabilityRegistry(logger)
    registry.declareCapability(videoclipsCapability)
    registry.ready()
    const caller = videoclipsCaller(registry, logger)
    await expect(listSources(caller, UNFILTERED_DEVICE_ID)).rejects.toThrow(
      /not registered for device 102/,
    )
  })

  it('a source that declares a method optional refuses by NAME across the fork', async () => {
    // `callSource`'s own `typeof fn !== 'function'` guard is VACUOUS here, and
    // that is the whole point: a forked provider reaches the hub as a proxy
    // that fabricates a callable for every property, so the guard passes and
    // the absence is only observable on the child. Before the child said so
    // with a token, an honest "this source is a time WINDOW with no file
    // behind it" arrived as INTERNAL_SERVER_ERROR — indistinguishable from a
    // method somebody forgot. Measured on the live hub 2026-09-24: it threw on
    // every player open over our own clips.
    const { logger } = makeLogger()
    const caller = videoclipsCaller(
      makeRegistry({ analytics: { optionalRefusal: true } }, logger),
      logger,
    )
    await expect(
      caller['getPlaybackOptions']?.({
        deviceId: UNFILTERED_DEVICE_ID,
        provider: ANALYTICS_ADDON,
      }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })

  it('a call that names no device is refused — the dispatcher has nothing to resolve', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(makeRegistry({ withNative: true }, logger), logger)
    await expect(caller['listClips']?.({ ...WINDOW })).rejects.toThrow(/deviceId/)
  })
})

// ── The fan-out: every source, no dedup, newest first (D549 decision 2) ──

/**
 * The DISPATCHER's rules, asked of the dispatcher.
 *
 * `videoclips.listClips` no longer reaches them through the router — naming a
 * provider is required (D554 amended) — but they are not videoclips' rules: every
 * device-scoped collection cap inherits them, and `listSources` takes the
 * fan-out and the failure isolation on every two-source camera today. So they
 * are pinned against the real `requireDeviceCollection` rather than deleted
 * with the one route that stopped using them. The merge ORDER has no caller on
 * this fleet any more; it is the rule the next collection cap is born with
 * (D554 decision 7), and a rule nothing checks has already been broken.
 */
describe('the device-collection dispatcher fans out across a device’s sources', () => {
  it('BOTH sources answer for ONE camera — the operator loses nothing', async () => {
    const { logger } = makeLogger()
    const rows = await fanOutClips(
      makeRegistry({ withNative: true }, logger),
      logger,
      UNFILTERED_DEVICE_ID,
    )
    expect([...sourcesOf(rows)].sort()).toEqual([ANALYTICS_SOURCE, NATIVE_SOURCE].sort())
  })

  it('the SAME clip held in two storages appears TWICE, one row per source', async () => {
    const { logger } = makeLogger()
    const rows = await fanOutClips(
      makeRegistry(
        {
          withNative: true,
          analytics: { clips: [clipAt(ANALYTICS_SOURCE, 1_758_000_060_000, 'twin')] },
          native: { clips: [clipAt(NATIVE_SOURCE, 1_758_000_060_000, 'twin')] },
        },
        logger,
      ),
      logger,
      UNFILTERED_DEVICE_ID,
    )
    // Same window, two rows, two sources: "the same clip, in two places" —
    // never deduped, never best-source-picked (D549 decision 11).
    expect(idsOf(rows)).toHaveLength(2)
    expect([...sourcesOf(rows)].sort()).toEqual([ANALYTICS_SOURCE, NATIVE_SOURCE].sort())
  })

  it('the merged list is newest-first ACROSS sources, not source by source', async () => {
    const { logger } = makeLogger()
    const registry = makeRegistry(
      {
        withNative: true,
        analytics: {
          clips: [
            clipAt(ANALYTICS_SOURCE, 1_758_000_090_000, 'a1'),
            clipAt(ANALYTICS_SOURCE, 1_758_000_030_000, 'a2'),
          ],
        },
        native: {
          clips: [
            clipAt(NATIVE_SOURCE, 1_758_000_060_000, 'n1'),
            clipAt(NATIVE_SOURCE, 1_758_000_000_000, 'n2'),
          ],
        },
      },
      logger,
    )
    expect(idsOf(await fanOutClips(registry, logger, UNFILTERED_DEVICE_ID))).toEqual([
      `${ANALYTICS_SOURCE}:1758000090000:a1`,
      `${NATIVE_SOURCE}:1758000060000:n1`,
      `${ANALYTICS_SOURCE}:1758000030000:a2`,
      `${NATIVE_SOURCE}:1758000000000:n2`,
    ])
  })

  /**
   * The promise slice 6 makes to every camera that resolves to exactly one
   * source — which, now that naming a provider is required (D554 amended), is EVERY
   * `listClips` call. One source is not merged, not re-sorted and not
   * re-wrapped: the provider's own array, in the provider's own order. A merge
   * comparator that "tidies" a single source would change the list under an
   * operator who changed nothing.
   */
  it('a ONE-source camera gets its provider rows verbatim, in the provider order', async () => {
    const { logger } = makeLogger()
    const unsorted = [
      clipAt(ANALYTICS_SOURCE, 1_758_000_030_000, 'older-first'),
      clipAt(ANALYTICS_SOURCE, 1_758_000_090_000, 'newer-second'),
    ]
    const caller = videoclipsCaller(
      makeRegistry({ withNative: false, analytics: { clips: unsorted } }, logger),
      logger,
    )
    expect(idsOf(await listClipsFrom(caller, UNFILTERED_DEVICE_ID, ANALYTICS_ADDON))).toEqual([
      unsorted[0]!.id,
      unsorted[1]!.id,
    ])
  })
})

// ── One source failing never empties the others (D549 consequences) ──

describe('videoclips — a source that cannot answer is isolated and NAMED', () => {
  it('one provider throwing leaves the other source listed', async () => {
    const { logger, warns } = makeLogger()
    const registry = makeRegistry(
      { withNative: true, native: { failWith: 'camera refused: 400 empty body' } },
      logger,
    )
    expect(sourcesOf(await fanOutClips(registry, logger, UNFILTERED_DEVICE_ID))).toEqual([
      ANALYTICS_SOURCE,
    ])
    const dropped = warns.find((w) => w.message.includes('source failed'))
    expect(dropped).toBeDefined()
    // Every line about a camera carries the numeric deviceId, always the same
    // key — a miss rate is always asked per camera.
    expect(Reflect.get(Object(dropped?.meta), 'tags')).toMatchObject({
      deviceId: UNFILTERED_DEVICE_ID,
    })
  })

  it('listSources reports the failed source as unreachable WITH the reason — never an empty list', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(
      makeRegistry(
        { withNative: true, native: { failWith: 'camera refused: 400 empty body' } },
        logger,
      ),
      logger,
    )
    const rows = await listSources(caller, UNFILTERED_DEVICE_ID)
    expect(statesOf(rows)).toEqual(['ok', 'unreachable'])
    const reasons = rows as readonly { readonly availability: { readonly reason?: string } }[]
    expect(reasons[1]?.availability.reason).toContain('400 empty body')
  })

  it("a sleeping source's own row travels through untouched, catalogAsOf and all", async () => {
    const { logger } = makeLogger()
    const asleep: ClipSource = {
      source: NATIVE_SOURCE,
      label: 'SD card',
      availability: { state: 'sleeping', reason: 'battery camera asleep', catalogAsOf: 1_757_000 },
    }
    const caller = videoclipsCaller(
      makeRegistry({ withNative: true, native: { sources: [asleep] } }, logger),
      logger,
    )
    const rows = await listSources(caller, UNFILTERED_DEVICE_ID)
    expect(statesOf(rows)).toEqual(['ok', 'sleeping'])
    const typed = rows as readonly { readonly availability: { readonly catalogAsOf?: number } }[]
    expect(typed[1]?.availability.catalogAsOf).toBe(1_757_000)
  })
})

// ── getClipPlayback dispatches by the source inside the id ───────────

describe('videoclips — getClipPlayback routes by the clip id it was given', () => {
  it('a native id reaches the native provider', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(makeRegistry({ withNative: true }, logger), logger)
    const answer = await caller['getClipPlayback']?.({
      deviceId: UNFILTERED_DEVICE_ID,
      clipId: `${NATIVE_SOURCE}:0:Zm9v`,
    })
    expect(playbackUrlOf(answer)).toBe(`${NATIVE_SOURCE}://${NATIVE_SOURCE}:0:Zm9v`)
  })

  it('an analytics id reaches the analytics provider, in the same build', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(makeRegistry({ withNative: true }, logger), logger)
    const answer = await caller['getClipPlayback']?.({
      deviceId: UNFILTERED_DEVICE_ID,
      clipId: 'analytics:1758000000000:1758000030000:ev-1',
    })
    expect(playbackUrlOf(answer)).toBe('analytics://analytics:1758000000000:1758000030000:ev-1')
  })

  it('an id no source claims is REFUSED, naming it — never answered by the first provider', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(makeRegistry({ withNative: true }, logger), logger)
    await expect(
      caller['getClipPlayback']?.({ deviceId: UNFILTERED_DEVICE_ID, clipId: 'hksv:102:1-2' }),
    ).rejects.toThrow(/hksv:102:1-2/)
  })

  /**
   * One source needs no dispatch, and asking it which ids it owns would be a
   * round trip bought for nothing — the cheap question first (D54). This also
   * keeps a single-provider camera on exactly the call sequence it has today.
   */
  it('a ONE-source camera plays straight through, with no listSources probe', async () => {
    const { logger } = makeLogger()
    const calls: Record<string, number> = {}
    const caller = videoclipsCaller(
      makeRegistry({ withNative: false, analytics: { calls } }, logger),
      logger,
    )
    const answer = await caller['getClipPlayback']?.({
      deviceId: UNFILTERED_DEVICE_ID,
      clipId: 'analytics:1:2:ev',
    })
    expect(playbackUrlOf(answer)).toBe('analytics://analytics:1:2:ev')
    expect(calls['listSources']).toBeUndefined()
    expect(calls['getClipPlayback']).toBe(1)
  })
})

// ── The device's sources come from its BINDINGS (2026-09-20 restructure) ──

/**
 * `videoclips.listSources({deviceId: 107})` on the live hub answered FOUR rows,
 * three of them `analytics`:
 *
 * ```
 * { source: 'analytics', addonId: 'native' }
 * { source: 'analytics', addonId: 'pipeline-analytics' }
 * { source: 'analytics', addonId: 'pipeline-analytics@agent-a' }
 * { source: 'native:reolink:onboard', addonId: 'provider-reolink' }
 * ```
 *
 * One addon, reached three ways: as the device's NATIVE provider (asked
 * separately, D556 decision 5), as the hub-local registration, and as the same
 * addon on the agent node under the `<addonId>@<nodeId>` key.
 * `capabilities.getCapability` listed a fourth, on the Mac node. In a picker
 * that is three tick-boxes for one thing.
 *
 * The cause is that the dispatcher enumerated REGISTRATIONS. The framework
 * already answers "which providers does this device have" — the device's
 * BINDINGS (`deviceManager.getBindings`), which is what every per-camera
 * switch and every D12 aggregate decides on, and which `setWrapperActive`
 * (D62) is the authority over. A binding-derived list cannot produce three
 * rows for one provider in the first place, and it needs no collapse after the
 * fact.
 *
 * A read that FAILS must not destroy work (D49): when the device manager is
 * not reachable the dispatcher keeps the registration set rather than
 * answering an empty list, because "this camera has no recordings" is the
 * defect this whole line of work is about. Every test above this block takes
 * that path, which is why they still describe a fan-out.
 */
describe('videoclips — the device SOURCES are its bindings, not the registrations', () => {
  const HUB_LOCAL = 'pipeline-analytics'
  const ON_AGENT = 'pipeline-analytics@agent-a'
  const NATIVE_STAMP = 'native'
  const DEVICE_MANAGER_CAP = 'device-manager'
  const DEVICE_MANAGER_ADDON = 'device-manager'

  interface BoundOptions {
    /** `providerAddonId` of each `videoclips` binding entry this device has. */
    readonly bound: readonly string[]
    /** Make `getBindings` throw — the read that must not destroy work. */
    readonly bindingsThrow?: boolean
  }

  /** The live shape: one analytics source registered three ways, plus Reolink. */
  function liveRegistry(options: BoundOptions, logger: IScopedLogger): CapabilityRegistry {
    const registry = new CapabilityRegistry(logger)
    registry.declareCapability(videoclipsCapability)
    registry.registerNativeProvider(
      'videoclips',
      UNFILTERED_DEVICE_ID,
      NATIVE_STAMP,
      makeProvider(ANALYTICS_SOURCE, { registration: NATIVE_STAMP }),
    )
    registry.registerProvider(
      'videoclips',
      HUB_LOCAL,
      makeProvider(ANALYTICS_SOURCE, { registration: HUB_LOCAL }),
    )
    registry.registerProvider(
      'videoclips',
      NATIVE_ADDON,
      makeProvider(NATIVE_SOURCE, { registration: NATIVE_ADDON }),
    )
    registry.registerProvider(
      'videoclips',
      ON_AGENT,
      makeProvider(ANALYTICS_SOURCE, { registration: ON_AGENT }),
    )
    // The real cap def demands the device-settings trio; this double answers
    // exactly one question, so it is declared as the narrow singleton the
    // dispatcher actually reads.
    registry.declareCapability({
      ...deviceManagerCapability,
      exposesDeviceSettings: false,
      methods: {},
    })
    registry.registerProvider(DEVICE_MANAGER_CAP, DEVICE_MANAGER_ADDON, {
      getBindings: async (input: { deviceId: number }) => {
        if (options.bindingsThrow === true) throw new Error('settings door timed out')
        return {
          deviceId: input.deviceId,
          entries: options.bound.map((providerAddonId) => ({
            capName: 'videoclips',
            kind: 'wrapped' as const,
            providerAddonId,
            providerNodeId: 'hub',
            nativeAddonId: '',
          })),
        }
      },
    })
    registry.ready()
    return registry
  }

  /** `addonId` of each listing row, in order. */
  function addonIdsOf(value: unknown): readonly string[] {
    return fieldOf(value, 'addonId')
  }

  it('lists the source ONCE — the binding names one provider, not three registrations', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(liveRegistry({ bound: [HUB_LOCAL] }, logger), logger)
    const rows = await listSources(caller, UNFILTERED_DEVICE_ID)
    expect(sourcesOf(rows)).toEqual([ANALYTICS_SOURCE])
    expect(addonIdsOf(rows)).toEqual([HUB_LOCAL])
  })

  it('lists that source’s clips ONCE, not once per registration', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(liveRegistry({ bound: [HUB_LOCAL] }, logger), logger)
    expect(idsOf(await listClipsFrom(caller, UNFILTERED_DEVICE_ID, HUB_LOCAL))).toEqual([
      `${ANALYTICS_SOURCE}:1758000000000:a`,
    ])
  })

  it('a scalar call reaches the BOUND registration, not whichever registered first', async () => {
    // The native registration is first in every registry map. Only the binding
    // says which provider this camera's clips really come from.
    const { logger } = makeLogger()
    const caller = videoclipsCaller(liveRegistry({ bound: [HUB_LOCAL] }, logger), logger)
    const answer = await caller['getClipPlayback']?.({
      deviceId: UNFILTERED_DEVICE_ID,
      clipId: `${ANALYTICS_SOURCE}:1:2:ev`,
    })
    expect(playbackUrlOf(answer)).toBe(`${HUB_LOCAL}://${ANALYTICS_SOURCE}:1:2:ev`)
  })

  it('a source exists because a binding put it there — bind Reolink and it appears', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(liveRegistry({ bound: [NATIVE_ADDON] }, logger), logger)
    const rows = await listSources(caller, UNFILTERED_DEVICE_ID)
    expect(sourcesOf(rows)).toEqual([NATIVE_SOURCE])
    expect(addonIdsOf(rows)).toEqual([NATIVE_ADDON])
  })

  it('a camera bound to BOTH still gets both, once each', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(
      liveRegistry({ bound: [HUB_LOCAL, NATIVE_ADDON] }, logger),
      logger,
    )
    expect(sourcesOf(await listSources(caller, UNFILTERED_DEVICE_ID))).toEqual([
      ANALYTICS_SOURCE,
      NATIVE_SOURCE,
    ])
  })

  it('a bindings read that FAILS keeps the registrations rather than emptying the camera', async () => {
    // D49: a read that fails changes nothing. An empty source list reads as
    // "this camera has no recordings", which is the defect, not the fix.
    const { logger, warns } = makeLogger()
    const caller = videoclipsCaller(
      liveRegistry({ bound: [HUB_LOCAL], bindingsThrow: true }, logger),
      logger,
    )
    const rows = await listSources(caller, UNFILTERED_DEVICE_ID)
    expect(sourcesOf(rows).length).toBeGreaterThan(0)
    const dropped = warns.find((w) => w.message.includes('bindings'))
    expect(dropped).toBeDefined()
    expect(Reflect.get(Object(dropped?.meta), 'tags')).toMatchObject({
      deviceId: UNFILTERED_DEVICE_ID,
    })
  })

  it('a binding naming a provider nobody registered is a named drop, not a silent one', async () => {
    const { logger, warns } = makeLogger()
    const caller = videoclipsCaller(
      liveRegistry({ bound: [HUB_LOCAL, 'addon-that-never-booted'] }, logger),
      logger,
    )
    expect(sourcesOf(await listSources(caller, UNFILTERED_DEVICE_ID))).toEqual([ANALYTICS_SOURCE])
    expect(warns.some((w) => w.message.includes('addon-that-never-booted'))).toBe(true)
  })
})

// ── ONE provider at a time (operator, 2026-09-20) ────────────────────

/**
 * *"l'utilizzatore è uno solo"* [there is only one user]. The `sources?: string[]` view filter is gone:
 * a clip list is asked of ONE provider, named by the `addonId` a `listSources`
 * row carries — and the name is REQUIRED (D554 amended).
 *
 * It was documented as optional, "absent means the device's bound provider,
 * which is CamStack on every camera". Measured on the live hub 2026-09-20,
 * device 107 bound to `recorder` AND `provider-reolink`: a bare `listClips`
 * with `limit: 3` answered **six** rows, three from each source, merged
 * newest-first. There was no default resolution anywhere in the dispatcher —
 * absence simply left the fan-out un-narrowed. The test that "proved" the
 * default bound the camera to ONE provider, where D554 decision 6 ("one source
 * is not a merge") gives the same answer for a different reason, so the claim
 * was never exercised.
 *
 * A collection cap's binding set is DERIVED and plural (D554 amended, step 0),
 * so there is no "the bound one" to resolve to. Absence is therefore refused,
 * in the INPUT SCHEMA, so no caller can omit it undetected.
 *
 * A provider the device is NOT bound to is refused BY NAME rather than
 * answered by another one: that is `rejectUnresolvedAddonPin`'s rule (D552),
 * and the alternative is a caller who asked for the camera's own SD card and
 * got the analytics visit log back without being told.
 */
describe('videoclips — listClips is asked of ONE provider', () => {
  const HUB_LOCAL = 'pipeline-analytics'
  const DEVICE_MANAGER_CAP = 'device-manager'

  function boundTo(bound: readonly string[], logger: IScopedLogger): CapabilityRegistry {
    const registry = new CapabilityRegistry(logger)
    registry.declareCapability(videoclipsCapability)
    registry.registerProvider(
      'videoclips',
      HUB_LOCAL,
      makeProvider(ANALYTICS_SOURCE, { registration: HUB_LOCAL }),
    )
    registry.registerProvider(
      'videoclips',
      NATIVE_ADDON,
      makeProvider(NATIVE_SOURCE, { registration: NATIVE_ADDON }),
    )
    registry.declareCapability({
      ...deviceManagerCapability,
      exposesDeviceSettings: false,
      methods: {},
    })
    registry.registerProvider(DEVICE_MANAGER_CAP, 'device-manager', {
      getBindings: async (input: { deviceId: number }) => ({
        deviceId: input.deviceId,
        entries: bound.map((providerAddonId) => ({
          capName: 'videoclips',
          kind: 'wrapped' as const,
          providerAddonId,
          providerNodeId: 'hub',
          nativeAddonId: '',
        })),
      }),
    })
    registry.ready()
    return registry
  }

  it('names ONE provider and gets only that one’s clips', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(boundTo([HUB_LOCAL, NATIVE_ADDON], logger), logger)
    const rows = await caller['listClips']?.({
      deviceId: UNFILTERED_DEVICE_ID,
      ...WINDOW,
      provider: NATIVE_ADDON,
    })
    expect(sourcesOf(rows)).toEqual([NATIVE_SOURCE])
  })

  // The live shape of 592: two bound providers, no `provider` named. This is
  // the case the old "default" test never built — it bound ONE provider, where
  // the answer is the same whatever the rule is.
  it('names none on a camera with TWO bound providers and is REFUSED, not merged', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(boundTo([HUB_LOCAL, NATIVE_ADDON], logger), logger)
    await expect(listClips(caller, UNFILTERED_DEVICE_ID)).rejects.toThrow(/provider/i)
  })

  it('a bare call never answers with rows from more than one source', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(boundTo([HUB_LOCAL, NATIVE_ADDON], logger), logger)
    const answered = await listClips(caller, UNFILTERED_DEVICE_ID).catch(() => null)
    // Red before the fix with BOTH sources listed — the union the docblock
    // said this method is not. `null` is the refusal, which is the fix.
    expect(answered === null ? [] : sourcesOf(answered)).toEqual([])
  })

  // Not "required when ambiguous": a rule that only bites on some cameras is
  // how a docblock and a dispatcher drift apart in the first place.
  it('refuses a bare call on a ONE-provider camera too', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(boundTo([HUB_LOCAL], logger), logger)
    await expect(listClips(caller, UNFILTERED_DEVICE_ID)).rejects.toThrow(/provider/i)
  })

  it('names a provider the device is not bound to and is REFUSED by name', async () => {
    const { logger } = makeLogger()
    const caller = videoclipsCaller(boundTo([HUB_LOCAL], logger), logger)
    await expect(
      caller['listClips']?.({
        deviceId: UNFILTERED_DEVICE_ID,
        ...WINDOW,
        provider: NATIVE_ADDON,
      }),
    ).rejects.toThrow(new RegExp(NATIVE_ADDON))
  })
})
