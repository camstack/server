/**
 * The per-device COLLECTION dispatcher — a capability whose providers are
 * SOURCES of one device, listed beside each other.
 *
 * `requireDeviceScoped` (`cap-mount-helpers.ts`) resolves ONE provider for a
 * device: the native, else the D13 `getProviderForDevice`. That is right for a
 * cap where a device has one answer. `videoclips` is not that cap any more
 * (D549 decision 2, D554): a camera's clips live in several places at once —
 * the analytics visit log, the camera's own SD card, a hub's storage, HomeKit
 * — and the operator asked for all of them, side by side, never one hidden
 * behind another. `getProviderForDevice` on a collection cap returns the FIRST
 * registered provider, so leaving `videoclips` on it would have answered every
 * camera from whichever addon booted first: the same silent single-answer
 * defect D552 closed, wearing a different hat.
 *
 * The three rules this module implements, and nothing else:
 *
 *  1. **Fan out, per device.** An ARRAY-returning method is called on every
 *     source the DEVICE has — its BINDINGS ({@link sourcesForDevice}), not the
 *     registrations — and the results are concatenated. No dedup ACROSS
 *     SOURCES, no best-source pick: a clip held in two storages appears twice,
 *     once per source, and each row says which (D549 decision 11 — stated
 *     there as a consequence precisely so it is not "fixed" later). A source
 *     is not a REGISTRATION: one addon reaches this dispatcher as the device's
 *     native provider, as the hub-local registration and once per agent node.
 *     Those three are collapsed by the binding set itself, which cannot hold
 *     one addon twice — never by a de-duplicator over the answer. On 592 they
 *     were three `analytics` tick-boxes for one thing, D62's defect with the
 *     polarity reversed (D554 amended 2026-09-20).
 *
 *     **A caller may also pin ONE source, and for `videoclips.listClips` the
 *     pin is REQUIRED** — in the cap's input schema, not here (D554 amended). This
 *     dispatcher has no notion of a DEFAULT provider and never had one: a
 *     collection cap's binding set is derived and plural, so an absent pin
 *     left the fan-out un-narrowed and bought a union. The cap's docblock
 *     said otherwise for a day, and device 107 answered a `limit: 3` call
 *     with six rows because of it.
 *  2. **One failing source never empties the others.** Every source is called
 *     independently and a rejection removes only its own rows — and says so,
 *     per source, with `tags: { deviceId }`. A fan-out where one throwing
 *     provider empties the list is worse than no fan-out. For the SOURCE
 *     listing itself the failure becomes a row (`unreachable` + the reason):
 *     an empty list from a camera nobody could reach reads as "this camera has
 *     no recordings", which is the defect this whole line of work is about.
 *  3. **A scalar method routes by the SOURCE inside the id it carries.** Clip
 *     ids are self-contained and source-prefixed (`analytics:…`,
 *     `native:reolink:onboard:…`, `hksv:…`), so the dispatcher asks each
 *     source which ids it owns ({@link SOURCE_LISTING_METHOD}) and hands the
 *     call to the one that claims the longest matching prefix. Several
 *     registrations of one source all claim it: the FIRST serving one wins,
 *     and it is the registration the collapsed listing row names. An id nobody
 *     claims is REFUSED by name — never handed to the first provider, which is
 *     how a fabricated `addonId` once came back with another addon's answer
 *     (D552 consequences, `rejectUnresolvedAddonPin`).
 *
 * A device with exactly ONE source skips 1's merge and 3's probe entirely: its
 * rows are returned verbatim in the provider's own order and its scalar calls
 * go straight through. That is not an optimisation — it is the promise that a
 * camera with one provider behaves exactly as it did before this mount
 * existed, and it is pinned by spec.
 */

import { CAP_METHOD_NOT_IMPLEMENTED, type CapabilityRegistry } from '@camstack/system'
import {
  type CapabilityMethodSchema,
  type DeviceBindingEntry,
  deviceExtensionCapability,
  EXTENSION_SLOT_LISTING_METHOD,
  expandCapMethods,
  type IScopedLogger,
  isArrayOutputSchema,
  reservedSourceOwner,
  unreachableExtensionSlotRow,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'

/** A method the dispatcher can call on a resolved source provider. */
type ProviderMethod = (input?: unknown) => unknown
/** A source provider as the dispatcher sees it — structural method bag. */
type SourceProvider = Readonly<Record<string, ProviderMethod>>

/**
 * The device-collection CONVENTION: a cap whose providers are sources declares
 * this method, taking `{ deviceId }` and returning one row per source with a
 * `source` id and an `availability` block. It is what makes rule 3 possible
 * without a second registry of id prefixes — the provider that mints the ids
 * is the one that names them.
 */
export const SOURCE_LISTING_METHOD = 'listSources'
/** The field on a source row that carries its id / clip-id namespace. */
const SOURCE_ID_FIELD = 'source'
/** The field on a source row that names the addon serving it (D555/D557). */
const SOURCE_ADDON_FIELD = 'addonId'
/**
 * The input field naming WHICH of a device's providers to ask. One at a time,
 * by `addonId`, never a list of source ids: the operator settled the surface
 * on 2026-09-20 (*"l'utilizzatore è uno solo"* [there is only one user]).
 *
 * An absent pin narrows NOTHING — the method fans out, which is right for
 * `listSources` and was never right for `listClips`. Whether absence is
 * allowed is the CAP's to say, in its input schema, and `videoclips.listClips`
 * says no (D554 amended).
 */
const PROVIDER_PIN_FIELD = 'provider'

/** The capability whose singleton answers what a device is bound to. */
const DEVICE_MANAGER_CAP = 'device-manager'

/** One source of a device: the provider plus the addon the binding named. */
interface DeviceSource {
  readonly addonId: string
  readonly provider: SourceProvider
}

/**
 * The slice of the device manager this dispatcher reads — the framework's
 * answer to "which providers does this device have". Deliberately narrower
 * than the addon: nothing here may write a binding.
 */
interface DeviceBindingsReader {
  getBindings(input: {
    deviceId: number
  }): Promise<{ readonly entries: readonly DeviceBindingEntry[] }>
}

/**
 * EVERY source a DEVICE has — read from the device's BINDINGS, which is the
 * framework's answer to "which providers does this device have".
 *
 * It used to enumerate REGISTRATIONS, and that is what put `analytics` in the
 * picker three times on the first live run (device 107, 2026-09-20): one addon
 * reached here as the device's native provider, as the hub-local registration
 * and again as `pipeline-analytics@agent-a`, with a fourth on the Mac
 * node that `resolveCollectionForDevice` had already dropped. Three tick-boxes
 * for one thing, and `listClips` triplicating every row underneath them.
 *
 * A binding is one per `(device, cap, provider)` and `setWrapperActive` (D62)
 * is the authority over it, so **three rows for one provider stop being
 * representable** — there is nothing to de-duplicate after the fact. It also
 * makes the list mean what the operator says it means: a source exists for a
 * camera because a configuration elsewhere put it there, not because some
 * addon somewhere registered the capability.
 *
 * The binding names an ADDON, never a shape: `DeviceBindingEntry.kind` is UI
 * metadata and is not branched on here (D13). A named addon is looked up in the
 * cap's collection map, and failing that against the device's native provider,
 * which the registry cannot always NAME (a cross-process native arrives through
 * `setNativeFallback` with no addon id of its own) — in that case the binding is
 * the only thing that names it.
 *
 * **A bindings read that FAILS keeps the registration set** (D49). Answering an
 * empty list would read as "this camera has no recordings", which is the defect
 * this whole line of work exists to end, so a failure is logged and the old
 * behaviour stands for that call.
 */
async function sourcesForDevice(
  registry: CapabilityRegistry,
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): Promise<readonly DeviceSource[]> {
  const registered = new Map<string, SourceProvider>(
    registry.getCollectionEntries<SourceProvider>(capName),
  )
  const bound = await boundAddonIds(registry, capName, deviceId, logger)
  if (bound === null) return registrationsForDevice(registry, capName, deviceId)

  const sources: DeviceSource[] = []
  for (const addonId of bound) {
    const provider = registered.get(addonId) ?? nativeNamedBy(registry, capName, deviceId, addonId)
    if (provider === undefined) {
      // A binding whose provider never booted is a DROPPED source, and a
      // dropped source that says nothing is indistinguishable from a camera
      // that has none.
      logger?.warn(
        `${capName}: device is bound to "${addonId}", which has registered no provider here`,
        { tags: { deviceId, addonId }, meta: { capability: capName } },
      )
      continue
    }
    sources.push({ addonId, provider })
  }
  return sources
}

/**
 * The addon ids the device is bound to for `capName`, or `null` when the
 * bindings could not be read at all (never an empty list for that case — the
 * two must not look alike).
 */
async function boundAddonIds(
  registry: CapabilityRegistry,
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): Promise<readonly string[] | null> {
  const manager = registry.getSingleton<DeviceBindingsReader>(DEVICE_MANAGER_CAP)
  if (manager === null || typeof manager.getBindings !== 'function') {
    logger?.warn(`${capName}: no device manager to read this device's bindings from`, {
      tags: { deviceId },
      meta: { capability: capName },
    })
    return null
  }
  try {
    const answer = await manager.getBindings({ deviceId })
    const ids: string[] = []
    for (const entry of answer.entries) {
      if (entry.capName !== capName) continue
      const addonId = entry.providerAddonId
      if (addonId.length > 0 && !ids.includes(addonId)) ids.push(addonId)
    }
    return ids
  } catch (err: unknown) {
    logger?.warn(`${capName}: could not read this device's bindings — keeping the registrations`, {
      tags: { deviceId },
      meta: { capability: capName, reason: errMessage(err) },
    })
    return null
  }
}

/**
 * The device's native provider when the binding's addon id is the one that
 * registered it — or when the registry cannot name it at all, which is how a
 * cross-process native arrives (`setNativeFallback`). The native is not in
 * `state.providers`, so it is asked about separately (D556 decision 5).
 */
function nativeNamedBy(
  registry: CapabilityRegistry,
  capName: string,
  deviceId: number,
  addonId: string,
): SourceProvider | undefined {
  const native = registry.getNativeProvider<SourceProvider>(capName, deviceId)
  if (native === null) return undefined
  const nativeAddonId = registry.getNativeAddonId(capName, deviceId)
  if (nativeAddonId !== null && nativeAddonId !== addonId) return undefined
  return native
}

/**
 * What this dispatcher did before the bindings became its authority, kept for
 * exactly one caller: the failure path above. Every registered provider this
 * device may use, native first.
 */
function registrationsForDevice(
  registry: CapabilityRegistry,
  capName: string,
  deviceId: number,
): readonly DeviceSource[] {
  const admitted = new Set<SourceProvider>(
    registry.resolveCollectionForDevice<SourceProvider>(capName, String(deviceId)),
  )
  const sources: DeviceSource[] = []
  const seen = new Set<SourceProvider>()
  const native = registry.getNativeProvider<SourceProvider>(capName, deviceId)
  if (native !== null) {
    sources.push({
      addonId: registry.getNativeAddonId(capName, deviceId) ?? 'native',
      provider: native,
    })
    seen.add(native)
  }
  for (const [addonId, provider] of registry.getCollectionEntries<SourceProvider>(capName)) {
    if (!admitted.has(provider) || seen.has(provider)) continue
    seen.add(provider)
    sources.push({ addonId, provider })
  }
  return sources
}

/** Is `method` one of the cap's array-returning (fan-out) methods? */
function isFanOutMethod(registry: CapabilityRegistry, capName: string, method: string): boolean {
  const def = registry.getDefinition(capName)
  if (def === undefined) return false
  const schema: CapabilityMethodSchema | undefined = expandCapMethods(def)[method]
  if (schema === undefined || schema.kind === 'subscription') return false
  return isArrayOutputSchema(schema.output)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Call one source, naming the cap, the source and the method on any refusal. */
async function callSource(
  source: DeviceSource,
  method: string,
  input: unknown,
  capName: string,
  deviceId: number,
): Promise<unknown> {
  const fn = source.provider[method]
  if (typeof fn !== 'function') {
    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message: notImplementedMessage(capName, source.addonId, deviceId, method),
    })
  }
  // …and that check is VACUOUS for a forked provider: the UDS proxy fabricates
  // a callable for every property, so the absence is only observable on the
  // child. `child-cap-dispatch` answers a method declared `optionalMethod`
  // with a prefixed message, which becomes the SAME refusal here — otherwise
  // an honest "this source has no file behind it" arrives as
  // INTERNAL_SERVER_ERROR and reads as a method somebody forgot.
  try {
    return await fn.call(source.provider, input)
  } catch (err: unknown) {
    if (errMessage(err).includes(CAP_METHOD_NOT_IMPLEMENTED)) {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: notImplementedMessage(capName, source.addonId, deviceId, method),
      })
    }
    throw err
  }
}

/** One sentence for both arms, so the two paths cannot describe the same fact
 *  differently. */
function notImplementedMessage(
  capName: string,
  addonId: string,
  deviceId: number,
  method: string,
): string {
  return `Capability "${capName}" source "${addonId}" for device ${deviceId} does not implement "${method}"`
}

/**
 * The `startMs` a row is ordered by, or null when the row does not declare a
 * time range. A merge across sources is newest-first (D549 decision 2's
 * `(startMs, endMs, id)`); rows that carry no window — a source listing, say —
 * keep the order their providers produced them in.
 */
function startMsOf(row: unknown): number | null {
  if (row === null || typeof row !== 'object') return null
  const range: unknown = Reflect.get(row, 'timeRange')
  if (range === null || typeof range !== 'object') return null
  const startMs: unknown = Reflect.get(range, 'startMs')
  return typeof startMs === 'number' ? startMs : null
}

function endMsOf(row: unknown): number {
  if (row === null || typeof row !== 'object') return 0
  const range: unknown = Reflect.get(row, 'timeRange')
  if (range === null || typeof range !== 'object') return 0
  const endMs: unknown = Reflect.get(range, 'endMs')
  return typeof endMs === 'number' ? endMs : 0
}

function idOf(row: unknown): string {
  if (row === null || typeof row !== 'object') return ''
  const id: unknown = Reflect.get(row, 'id')
  return typeof id === 'string' ? id : ''
}

/** Newest-first by `(startMs, endMs, id)`; applied only when EVERY row has a window. */
function mergeRows(rows: readonly unknown[]): readonly unknown[] {
  if (rows.some((row) => startMsOf(row) === null)) return rows
  return [...rows].sort((a, b) => {
    const byStart = (startMsOf(b) ?? 0) - (startMsOf(a) ?? 0)
    if (byStart !== 0) return byStart
    const byEnd = endMsOf(b) - endMsOf(a)
    if (byEnd !== 0) return byEnd
    return idOf(a).localeCompare(idOf(b))
  })
}

/**
 * The row a source listing gets when the source could not be reached AT ALL.
 *
 * The source id is the addon's, because a provider that threw could not name
 * its own sources — saying "this provider, as a whole, did not answer" is the
 * honest version, and the reason carries the refusal verbatim. Never composed
 * with a provider's output: this row replaces rows that do not exist.
 */
function unreachableSourceRow(addonId: string, reason: string): Record<string, unknown> {
  return {
    [SOURCE_ID_FIELD]: addonId,
    label: addonId,
    availability: { state: 'unreachable', reason },
  }
}

/** Builds the row a source that could not answer becomes. */
type FailureRowBuilder = (addonId: string, reason: string) => unknown

/**
 * The fan-out methods whose failure BECOMES a row rather than an absence.
 *
 * `listSources` is the D554 convention for every device-collection cap. A cap
 * whose own listing is what a surface claims ABSENCE from adds its method here
 * with the row its schema declares for it: `device-extension.listSlots`
 * (D648), because "this camera has no extensions" read off a provider that
 * threw is exactly the D315 lie — and it must hold on a one-owner device too,
 * which is why {@link failureRowFor} is consulted on the single-source path as
 * well (for these methods only; `listSources` keeps its one-source verbatim
 * behaviour, D554 decision 6).
 */
const CAP_FAILURE_ROWS: Readonly<Record<string, Readonly<Record<string, FailureRowBuilder>>>> = {
  [deviceExtensionCapability.name]: {
    [EXTENSION_SLOT_LISTING_METHOD]: unreachableExtensionSlotRow,
  },
}

function failureRowFor(capName: string, method: string): FailureRowBuilder | null {
  const own = CAP_FAILURE_ROWS[capName]?.[method]
  if (own !== undefined) return own
  return method === SOURCE_LISTING_METHOD ? unreachableSourceRow : null
}

async function fanOut(
  sources: readonly DeviceSource[],
  method: string,
  input: unknown,
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): Promise<readonly unknown[]> {
  const isSourceListing = method === SOURCE_LISTING_METHOD
  const failureRow = failureRowFor(capName, method)
  const settled = await Promise.allSettled(
    sources.map(async (source) => await callSource(source, method, input, capName, deviceId)),
  )
  const rows: unknown[] = []
  for (const [index, result] of settled.entries()) {
    const source = sources[index]
    if (source === undefined) continue
    if (result.status === 'rejected') {
      const reason = errMessage(result.reason)
      // A branch that drops work says so — a fan-out that silently loses a
      // source is indistinguishable from a camera that has none.
      logger?.warn(`${capName}.${method}: source failed — its rows are missing from this answer`, {
        tags: { deviceId, addonId: source.addonId },
        meta: { capability: capName, method, reason },
      })
      if (failureRow !== null) rows.push(failureRow(source.addonId, reason))
      continue
    }
    if (!Array.isArray(result.value)) {
      logger?.warn(`${capName}.${method}: source answered a non-array — contributing nothing`, {
        tags: { deviceId, addonId: source.addonId },
        meta: { capability: capName, method },
      })
      continue
    }
    rows.push(...finishRows(source, result.value, isSourceListing, capName, deviceId, logger))
  }
  return mergeRows(rows)
}

/**
 * Stamp each source-listing row with the addon that really served it.
 *
 * The stamp is authoritative: a surface cannot otherwise resolve a source row
 * to who answers it, and the alternative — a `native:reolink:* →
 * provider-reolink` prefix table inside the widget — is a second authority on
 * provider identity living in the one package with no business knowing it
 * (D557). The registry's id is a fact; a provider's own value is a claim, so
 * the fact wins.
 *
 * It used to also DROP the rows of a source the operator had switched off, and
 * mark the listing row that let him switch it back on. That whole half went on
 * 2026-09-20: every provider always works, and a source exists for a camera
 * because a binding put it there — so "off" is an unbound provider, not a
 * second store beside the binding (D554 amended, D557 amended). Nothing here
 * filters any more; the filtering happened when {@link sourcesForDevice} read
 * the bindings.
 */
function finishRows(
  source: DeviceSource,
  rows: readonly unknown[],
  isSourceListing: boolean,
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): readonly unknown[] {
  if (!isSourceListing) return rows
  const out: unknown[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      out.push(row)
      continue
    }
    const id: unknown = Reflect.get(row, SOURCE_ID_FIELD)
    if (typeof id === 'string') {
      const owner = reservedSourceOwner(capName, id)
      if (owner !== null && owner !== source.addonId) {
        // A RESERVED id (D625) is the DEFAULT of a picker, expressed as a
        // value rather than as a sort order. A second row spelling it would
        // put that default back behind the fan-out order — the
        // `?? sources[0]` accident the reservation exists to remove. The row
        // goes and the addon's own rows stay: it may well have real sources,
        // and emptying a camera's picker over one bad row is worse than the
        // bad row. The guard in `scripts/` refuses the same spelling at build
        // time; this is what happens when an old build reaches a new hub.
        logger?.warn(
          `${capName}.${SOURCE_LISTING_METHOD}: source id "${id}" is RESERVED for "${owner}" — this addon's row is dropped`,
          {
            tags: { deviceId, addonId: source.addonId },
            meta: { capability: capName, sourceId: id, reservedFor: owner },
          },
        )
        continue
      }
    }
    out.push({ ...row, [SOURCE_ADDON_FIELD]: source.addonId })
  }
  return out
}

/** What each source claims: its ids, or "it could not say". */
interface SourceClaims {
  readonly claimed: ReadonlyMap<string, DeviceSource>
  readonly unknownClaims: readonly DeviceSource[]
}

async function claimsOf(
  sources: readonly DeviceSource[],
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): Promise<SourceClaims> {
  const claimed = new Map<string, DeviceSource>()
  const unknownClaims: DeviceSource[] = []
  const settled = await Promise.allSettled(
    sources.map(
      async (source) =>
        await callSource(source, SOURCE_LISTING_METHOD, { deviceId }, capName, deviceId),
    ),
  )
  for (const [index, result] of settled.entries()) {
    const source = sources[index]
    if (source === undefined) continue
    if (result.status === 'rejected' || !Array.isArray(result.value)) {
      // It could not name its sources, so it cannot be excluded on that basis
      // either — a read that FAILS must not destroy work (D49).
      logger?.warn(
        `${capName}.${SOURCE_LISTING_METHOD}: source could not name its ids — routing falls back to it only if it is the only such source`,
        {
          tags: { deviceId, addonId: source.addonId },
          meta: {
            capability: capName,
            reason: result.status === 'rejected' ? errMessage(result.reason) : 'non-array answer',
          },
        },
      )
      unknownClaims.push(source)
      continue
    }
    for (const row of result.value) {
      if (row === null || typeof row !== 'object') continue
      const id: unknown = Reflect.get(row, SOURCE_ID_FIELD)
      if (typeof id === 'string' && id.length > 0 && !claimed.has(id)) claimed.set(id, source)
    }
  }
  return { claimed, unknownClaims }
}

/** Every top-level string value of an object input — the candidate routing keys. */
function stringFieldsOf(input: unknown): readonly string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return []
  const out: string[] = []
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) out.push(value)
  }
  return out
}

/**
 * The source that owns a source-prefixed id: `<sourceId>` itself, or anything
 * under `<sourceId>:`. The LONGEST matching source wins, so
 * `native:reolink:onboard` beats a hypothetical `native:reolink`.
 */
function ownerOf(
  claims: SourceClaims,
  input: unknown,
): { readonly source: DeviceSource; readonly sourceId: string } | null {
  let best: { source: DeviceSource; sourceId: string } | null = null
  for (const value of stringFieldsOf(input)) {
    for (const [sourceId, source] of claims.claimed) {
      if (value !== sourceId && !value.startsWith(`${sourceId}:`)) continue
      if (best === null || sourceId.length > best.sourceId.length) best = { source, sourceId }
    }
  }
  return best
}

async function dispatchScalar(
  sources: readonly DeviceSource[],
  method: string,
  input: unknown,
  capName: string,
  deviceId: number,
  logger: IScopedLogger | undefined,
): Promise<unknown> {
  const claims = await claimsOf(sources, capName, deviceId, logger)
  const owner = ownerOf(claims, input)
  if (owner !== null) return await callSource(owner.source, method, input, capName, deviceId)

  const fallback = claims.unknownClaims.length === 1 ? claims.unknownClaims[0] : undefined
  if (fallback !== undefined) {
    logger?.warn(
      `${capName}.${method}: no source claimed this id — using the one source that could not name its ids`,
      {
        tags: { deviceId, addonId: fallback.addonId },
        meta: { capability: capName, method },
      },
    )
    return await callSource(fallback, method, input, capName, deviceId)
  }

  const known = [...claims.claimed.keys()]
  logger?.warn(`${capName}.${method}: refused — no source of this device claims the id`, {
    tags: { deviceId },
    meta: { capability: capName, method, knownSources: known, input },
  })
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      `Capability "${capName}.${method}": no source of device ${deviceId} claims ` +
      `${JSON.stringify(input)}. Sources: ${known.length > 0 ? known.join(', ') : '(none named)'}. ` +
      `An unclaimed id is refused rather than answered by another source.`,
  })
}

/**
 * The device's sources narrowed to the one the caller PINNED, if it pinned one.
 *
 * A pin the device is not bound to is REFUSED by name. Answering it from
 * another provider is how a fabricated addon id once came back with somebody
 * else's answer (D552, `rejectUnresolvedAddonPin`), and here it would hand a
 * caller who asked for the camera's own SD card the analytics visit log with
 * nothing saying so.
 */
function pinnedProvider(
  sources: readonly DeviceSource[],
  input: unknown,
  capName: string,
  deviceId: number,
): readonly DeviceSource[] {
  if (input === null || typeof input !== 'object') return sources
  const pin: unknown = Reflect.get(input, PROVIDER_PIN_FIELD)
  if (typeof pin !== 'string' || pin.length === 0) return sources
  const picked = sources.filter((source) => source.addonId === pin)
  if (picked.length > 0) return picked
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      `Capability "${capName}": device ${deviceId} is not bound to provider "${pin}". ` +
      `Bound providers: ${sources.map((source) => source.addonId).join(', ') || '(none)'}. ` +
      `A pin nobody answers is refused rather than served by another provider.`,
  })
}

/**
 * Build the per-device COLLECTION dispatcher for `capName` — the collection
 * twin of `requireDeviceScoped`, and the provider object the cap router's
 * `device-scoped` mount resolves when the cap's mode is `collection`.
 *
 * Returns null without a registry (the router then surfaces
 * PRECONDITION_FAILED), exactly as the singleton dispatcher does.
 */
export function requireDeviceCollection(
  registry: CapabilityRegistry | null,
  capName: string,
  logger?: IScopedLogger,
): SourceProvider | null {
  if (!registry) return null
  const dispatcher = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        return async (input: unknown): Promise<unknown> => {
          const deviceId =
            input !== null && typeof input === 'object' ? Reflect.get(input, 'deviceId') : undefined
          if (typeof deviceId !== 'number') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `${capName}.${prop}: input must carry numeric "deviceId"`,
            })
          }
          const bound = await sourcesForDevice(registry, capName, deviceId, logger)
          const sources = pinnedProvider(bound, input, capName, deviceId)
          if (sources.length === 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `Capability "${capName}" not registered for device ${deviceId}`,
            })
          }
          const first = sources[0]
          if (isFanOutMethod(registry, capName, prop)) {
            // One source is not a merge: its rows travel verbatim, in its own
            // order, so a camera with one provider answers exactly as it did
            // before this dispatcher existed (D554 decision 6). Only the
            // listing rows are finished, and only to carry the addon stamp.
            if (sources.length === 1 && first !== undefined) {
              if (CAP_FAILURE_ROWS[capName]?.[prop] !== undefined) {
                // A cap-declared failure row holds on a ONE-owner device too:
                // the fan-out's isolation is what turns a throw into a row, so
                // the lone source takes the fan-out.
                return await fanOut(sources, prop, input, capName, deviceId, logger)
              }
              const answered = await callSource(first, prop, input, capName, deviceId)
              if (!Array.isArray(answered)) return answered
              return finishRows(
                first,
                answered,
                prop === SOURCE_LISTING_METHOD,
                capName,
                deviceId,
                logger,
              )
            }
            return await fanOut(sources, prop, input, capName, deviceId, logger)
          }
          if (sources.length === 1 && first !== undefined) {
            return await callSource(first, prop, input, capName, deviceId)
          }
          return await dispatchScalar(sources, prop, input, capName, deviceId, logger)
        }
      },
    },
  )
  return dispatcher
}
