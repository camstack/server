import { userError } from '@camstack/types'
/**
 * Device query + live-runtime + provider/adoption operations for the
 * device-manager addon — the read/live half of the `IDeviceManagerProvider`
 * surface. Extracted verbatim from the `onInitialize` provider literal as free
 * functions taking a `ProviderContext` (DI). Input/return types are pinned to
 * the cap contract via `Parameters<IDeviceManagerProvider['x']>[0]` /
 * `ReturnType<…>` so the typed surface is identical to the inferred methods.
 *
 * Covers: persisted/live device queries (listPersistedByAddon, listAll,
 * getDevice, getChildren, getChildrenBatch), live runtime methods (getStreamSources,
 * getConfigSchema, getSettingsSchema, updateConfig, enable, disable, remove,
 * removeByIntegration, getStreamProfileMap, setStreamProfileMap, probeStreams),
 * device-provider ops (discoverDevices, adoptDevice, getCreationSchema,
 * createDevice, testCreationField), and device-adoption ops
 * (adoptionListCandidates/Refresh/Adopt/Release/Resync, testField).
 *
 * The hub-live-then-persisted-fallback union, the cross-process device-ops
 * dispatch, the depth-first remove cascade, and the resetToSource resync purge
 * are byte-for-byte preserved. `remove`/`removeByIntegration`/`enable`/`disable`/
 * `probeStreams`/`getStreamProfileMap` self-call sibling cap methods via
 * `pctx.provider`. Pure refactor — no behavior change.
 */

import type { ConfigUISchemaWithValues, IDevice, StreamSourceEntry } from '@camstack/types'
import {
  DeviceType,
  deviceManagerCapability,
  deviceProviderCapability,
  errMsg,
  InferProvider,
} from '@camstack/types'
import {
  buildSourceInfoFromConfig,
  isCameraDevice,
  persistedFeatures,
  persistedIsCamera,
  resolveDeviceById,
  toDeviceInfo,
  toDeviceRole,
} from './device-projection.js'
import { persistedOnlineFallback } from './device-online-fallback.js'
import { secretConfigPathsField } from './secret-config-paths.js'
import type { ProviderContext } from './device-provider-context.js'
import type { DeviceRow } from './device-row-store.js'

type IDeviceManagerProvider = InferProvider<typeof deviceManagerCapability>
type IDeviceProviderCap = InferProvider<typeof deviceProviderCapability>

/**
 * The ORIGINATING addon id off a cap-channel call's `args`, or `undefined`.
 *
 * Not part of `IDeviceManagerProvider['listAll']`'s public Zod schema —
 * `CapRouteResolver`'s hub-in-process dispatch merges it into `args` as an
 * out-of-band field (mirrors how `nodeId` already rides inline in args on
 * this same path), so it never crosses the tRPC/HTTP boundary and never
 * reaches a browser client. Only ever present on a call the parent itself
 * routed from a registered UDS child, never client-suppliable.
 */
function extractCallerAddonId(input: object): string | undefined {
  const raw: unknown = Reflect.get(input, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export async function listPersistedByAddon(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['listPersistedByAddon']>[0],
): ReturnType<IDeviceManagerProvider['listPersistedByAddon']> {
  const { addonId } = input
  // `addonId` is an indexed column, so this is the addon's rows and nothing
  // else. It used to be a `deviceIndex[addonId]` list of stableIds resolved
  // against the whole `deviceMeta` blob — with a `.get(...)!` that THREW when
  // the two disagreed, which is a skew the flatten makes unrepresentable.
  const rows = await pctx.metaStore.rows.listByAddon(addonId)
  const saved: Array<{
    id: number
    stableId: string
    type: string
    name: string
    location: string | null
    disabled: boolean
    parentDeviceId: number | null
  }> = []
  for (const row of rows) {
    const m = row.meta
    // A RESERVATION is not a device. `allocateDeviceId` writes a row for any
    // `(addonId, stableId)` it is handed — it is a public mutation — and the
    // row it writes is `type: 'generic'`, `name = stableId`, no config, and
    // NOT registered. Handing that to a provider's restore is how
    // `__camstack_probe_nonexistent__` (device 4370) made every boot log
    // `No device class registered for restored type` for an id that was
    // nothing but the answer to "does this device exist?" (D376).
    //
    // A reservation that carries CONFIG is different: that is a `create()`
    // whose `registerDevice` never landed, and the provider is exactly who
    // should finish it. So the config decides, not the flag alone.
    if (!row.registered) {
      const reserved = await pctx.settings.readDeviceStore(m.id)
      if (Object.keys(reserved ?? {}).length === 0) {
        pctx.host.ctx.logger.warn(
          'Skipping an unregistered device reservation with no configuration — not a device, not restored',
          { tags: { deviceId: m.id }, meta: { addonId, stableId: m.stableId, type: m.type } },
        )
        continue
      }
    }
    saved.push({
      id: m.id,
      stableId: m.stableId,
      type: m.type,
      name: m.name,
      location: m.location ?? null,
      disabled: m.disabled ?? false,
      parentDeviceId: m.parentDeviceId,
    })
  }
  return saved
}

// ── Live queries — serve from live registry when available ────────────

/**
 * Every requested device's persisted config in ONE store round trip (D870). A
 * store that cannot be asked THROWS and the listing fails with it: an
 * unreadable row is not a device with no settings (D49).
 */
async function readDeviceConfigs(
  pctx: ProviderContext,
  deviceIds: readonly number[],
): Promise<ReadonlyMap<number, Record<string, unknown>>> {
  if (deviceIds.length === 0) return new Map()
  return pctx.settings.readDeviceStoreBatch(deviceIds)
}

export async function listAll(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['listAll']>[0],
): ReturnType<IDeviceManagerProvider['listAll']> {
  // An owner filter that is PRESENT but is not an addon id is refused, never
  // widened to "everything".
  //
  // `addonId: null` is what a declarer produces when it reads `ctx.addonId` —
  // a field `AddonContext` does not have; the id is `ctx.id`. Measured on the
  // live hub 2026-08-09: nothing errored and all 319 devices came back, so a
  // `DeclaredDevices` wired that way silently takes the WHOLE CLUSTER as its
  // index — its `stableId` lookups can collide with another addon's, and its
  // withdrawal sweep considers rows it does not own. The Zod schema says
  // `addonId: z.string().optional()`, but a forked addon reaches this provider
  // over the UDS cap channel, which does not run it.
  //
  // Absence stays permissive, and explicitly so rather than accidentally:
  // `listAll({})` is the legitimate "everything" call and is spelled by
  // OMITTING the key (an explicitly-`undefined` key is spread syntax, and
  // means the same thing).
  const ownerFilter: unknown = Reflect.get(input, 'addonId')
  if (ownerFilter !== undefined && (typeof ownerFilter !== 'string' || ownerFilter.length === 0)) {
    throw new Error(
      `deviceManager.listAll: addonId must be a non-empty string or be omitted — got ${JSON.stringify(ownerFilter)}. ` +
        'An owner filter that is present but empty is never widened to every device. ' +
        'On an addon context the id is `ctx.id`; there is no `ctx.addonId`.',
    )
  }

  // Fleet-read-census attribution for a call that arrived over the cap
  // channel: `CapRouteResolver`'s hub-in-process dispatch merges the
  // ORIGINATING addon's id into `args` as `callerAddonId` (captured off
  // `LocalChildRegistry`'s registered `childId` — see `cap-route-resolver.ts`).
  // Never a client-supplied field on the public schema — it rides IN the args
  // object the same way an out-of-band `nodeId` pin already does elsewhere in
  // this repo, and a caller that sends its own `callerAddonId` cannot spoof
  // anything the census does not already trust the transport for.
  //
  // Read ONLY when armed — `censusArmed` is the boolean read FIRST, so a
  // disarmed census never pays for the `Reflect.get`.
  const callerAddonId = pctx.metaStore.rows.censusArmed ? extractCallerAddonId(input) : undefined

  const { addonId } = input
  // `slim` is the viewer's shape: everything that identifies a device, none of
  // the config blob. It is not only fewer bytes — the persisted branch below
  // reads each device's settings row ONE AT A TIME, so skipping `config` also
  // removes a per-device round-trip from a 293-device listing.
  const slim = input.projection === 'slim'
  const camerasOnly = input.isCamera === true
  // A NAMED id set. Filtered here rather than by the caller, because the whole
  // point is the bytes that never cross: the viewer's linked-devices panel
  // wants `type` + `online` for ~8 ids and was answered with 433 KB (slim) /
  // 958 KB (full) of 967 devices, on a query that refetches on the reconcile
  // interval. Absent ⇒ unfiltered, exactly as before; an EMPTY array is a
  // request for nothing and is honoured as one, never widened.
  const idFilter = input.deviceIds === undefined ? null : new Set(input.deviceIds)

  // Union of two sources, de-duped on (addonId, stableId):
  //   1. Hub-process live registry: IDevice instances owned by this
  //      process (hub-resident addons). Provides live `online`,
  //      features, and isCamera.
  //   2. `device-manager:devices`: the authoritative cross-process ledger,
  //      including devices owned by forked workers, whose IDevice
  //      instance lives in the worker's registry and is invisible to
  //      the hub-registry.
  //
  // Live wins on the overlap, so hub-owned devices keep their accurate
  // online/features. Forked-worker devices are reconstructed from
  // persisted metadata + persisted config.
  const results: ReturnType<typeof toDeviceInfo>[] = []
  const seen = new Set<string>()

  // ONE indexed scan of `device-manager:devices` — identity, hardware metadata
  // and ownership are columns of the same row now. This used to be three
  // SEQUENTIAL blob reads (`readMeta` / `readMetadataMap` / `readIndex`), each
  // a full read + `JSON.parse` of the 625 KB addon store on hub-main's event
  // loop; `listAll` runs once per device lifecycle event, so a 974-device boot
  // paid it ~3 000 times — 23% of a fully-saturated hub-main in the 2026-08-19
  // V8 profile.
  //
  // The id set and the projection are pushed INTO that scan (`listFleet`), so
  // a question about eight devices reads eight rows instead of nine hundred.
  // Filtering the answer was never the expensive half — the read was: ~1 017
  // rows a call, 14–54 calls a minute on the live hub 2026-08-25, to serve a
  // linked-devices panel that names its ids.
  //
  // `camerasOnly` is NOT pushed down — see `DEVICE_ROWS_SLIM_COLUMNS`. The
  // owner-filtered path keeps `listByAddon`: it is already narrow, and it is
  // the one branch where an addon asks about its OWN devices by name.
  const fleet = addonId
    ? await pctx.metaStore.rows.listByAddon(addonId)
    : await pctx.metaStore.rows.listFleet(
        {
          ...(input.deviceIds !== undefined ? { deviceIds: input.deviceIds } : {}),
          slim,
        },
        callerAddonId,
      )
  const rowById = new Map<number, DeviceRow>()
  for (const row of fleet) rowById.set(row.meta.id, row)

  if (pctx.registry) {
    const liveEntries = addonId
      ? pctx.registry.getAllForAddon(addonId).map((device) => ({ addonId: addonId!, device }))
      : pctx.registry.getAllWithAddonId()
    for (const { addonId: aid, device } of liveEntries) {
      const key = String(device.id)
      const row = rowById.get(device.id)
      const info = toDeviceInfo(aid, device, row?.metadata ?? null, row?.meta ?? null)
      seen.add(key)
      if (idFilter !== null && !idFilter.has(device.id)) continue
      if (camerasOnly && !info.isCamera) continue
      results.push(slim ? { ...info, config: {}, metadata: null } : info)
    }
  }

  // The per-device config reads, as ONE store round trip.
  //
  // This loop used to `await pctx.settings.readDeviceStore(m.id)` per row,
  // sequentially, on hub-main's event loop. On a 967-device fleet that is 967
  // round trips per FULL-projection listing, and the sqlite profiler measured
  // the aggregate at 9 229 `query addon-device-settings` a minute on
  // 2026-08-25 — the busiest read in the cluster by a factor of four, spent
  // almost entirely on devices whose config the caller then ignored.
  //
  // The slim projection removes the need for them; the batch removes the COST
  // of the ones that are still needed, so a caller that genuinely wants
  // `config` no longer pays a queue for it. Both, because either alone leaves
  // the other half of the bill: `slim` depends on every caller remembering, and
  // the batch alone still ships bytes nobody reads.
  const needConfigFor = slim
    ? []
    : fleet
        .filter((row) => !seen.has(String(row.meta.id)))
        .filter((row) => idFilter === null || idFilter.has(row.meta.id))
        .filter((row) => !camerasOnly || (row.meta.type as DeviceType) === DeviceType.Camera)
        .map((row) => row.meta.id)
  const configs = await readDeviceConfigs(pctx, needConfigFor)

  for (const row of fleet) {
    const m = row.meta
    const aid = m.addonId
    const stableId = m.stableId
    if (seen.has(String(m.id))) continue
    if (idFilter !== null && !idFilter.has(m.id)) continue
    const persistedType = m.type as DeviceType
    if (camerasOnly && persistedType !== DeviceType.Camera) continue
    const persistedConfig = configs.get(m.id) ?? {}
    const metadata = slim ? null : row.metadata
    results.push({
      id: m.id,
      stableId,
      addonId: aid,
      type: persistedType,
      name: m.name,
      location: m.location ?? null,
      disabled: m.disabled ?? false,
      parentDeviceId: m.parentDeviceId ?? null,
      // role is a first-class meta field — read from the persisted
      // meta row (stamped by setRole pre-seed in create()/spawnAccessoryChild).
      role: toDeviceRole(m.role),
      // Real per-device liveness from the mirrored `device-status`
      // slice the owning (forked) worker publishes via `markOnline`.
      // Fallback preserves legacy behaviour: registry===null is the
      // "offline view" (→false); a present registry with no mirrored
      // slice yet assumes online (→registry!==null) since persisted
      // state implies a successful registration by its owning process.
      // A device with NO configuration cannot be online (D376): its provider
      // can never restore it, so no owner will ever publish a `device-status`
      // slice to contradict a cheerful guess — which is how shell device 105
      // read `online: true` for a day while its restore failed eight times.
      online: pctx.host.resolveDeviceOnline(
        m.id,
        persistedOnlineFallback({
          registryPresent: pctx.registry !== null,
          parentDeviceId: m.parentDeviceId ?? null,
          config: persistedConfig,
        }),
      ),
      probed: pctx.host.resolveDeviceProbed(m.id),
      features: persistedFeatures(m.features),
      // Live IDevice isn't reachable from the hub, so infer
      // isCamera from the persisted DeviceType rather than the
      // method-presence check `toDeviceInfo` uses. Without this
      // forked-worker cameras looked non-camera to the stream-broker
      // and never got their RTSP restream wired up.
      isCamera: persistedIsCamera(persistedType),
      config: persistedConfig ?? {},
      ...secretConfigPathsField(pctx.secretConfigPaths.get(m.id)),
      metadata,
      ...(m.integrationId !== undefined ? { integrationId: m.integrationId } : {}),
      ...(m.linkDeviceId !== undefined ? { linkDeviceId: m.linkDeviceId } : {}),
      ...(m.primaryChildEntityId !== undefined
        ? { primaryChildEntityId: m.primaryChildEntityId }
        : {}),
      ...(m.childLayout !== undefined ? { childLayout: m.childLayout } : {}),
      ...(m.display !== undefined ? { display: m.display } : {}),
      // Forked-worker accessory children (e.g. HA sensor entities)
      // persist entityId + system in the config blob. Reconstruct
      // identity-only sourceInfo for dispatch routing.
      ...(() => {
        // Derived FROM config, so it cannot exist without it. Stated rather
        // than left to fall out of an empty object: a slim row has no
        // sourceInfo, and dispatch routing must not ask for one.
        if (slim) return {}
        const si = buildSourceInfoFromConfig(persistedConfig ?? {}, stableId, aid)
        return si !== undefined ? { sourceInfo: si } : {}
      })(),
    })
  }
  return results
}

export async function getDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getDevice']>[0],
): ReturnType<IDeviceManagerProvider['getDevice']> {
  const { deviceId } = input

  // Prefer live (hub-registry) when present; otherwise fall back to
  // persisted metadata so we also find devices owned by forked workers.
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      // One row: identity and hardware metadata are columns of it. This was
      // two whole-fleet blob reads issued in parallel.
      const row = await pctx.metaStore.getRow(found.device.id)
      return toDeviceInfo(found.addonId, found.device, row?.metadata ?? null, row?.meta ?? null)
    }
  }
  const row = await pctx.metaStore.getRow(deviceId)
  if (row === null) return null
  const { meta: m, metadata } = row
  const { addonId: aid, stableId } = m
  const persistedConfig = (await pctx.settings.readDeviceStore(m.id)) as Record<string, unknown>
  // Name now lives exclusively on the meta surface (mutated via
  // `setName` action) — the legacy config.name fallback is gone
  // since drivers no longer carry `name` in their config schema.
  const sourceInfoGetDevice = buildSourceInfoFromConfig(persistedConfig ?? {}, stableId, aid)
  return {
    id: deviceId,
    stableId,
    addonId: aid,
    type: m.type as DeviceType,
    name: m.name,
    location: m.location ?? null,
    disabled: m.disabled ?? false,
    parentDeviceId: m.parentDeviceId,
    // role is a first-class meta field — read from the persisted
    // meta row (stamped by setRole pre-seed in create()/spawnAccessoryChild).
    role: toDeviceRole(m.role),
    // Real per-device liveness from the mirrored `device-status` slice
    // the owning (forked) worker publishes via `markOnline`. Fallback
    // assumes online when no slice has been published yet — this branch
    // is the persisted fallback after a live-registry miss, so the
    // device is known to the hub and was registered by its owner.
    online: pctx.host.resolveDeviceOnline(
      deviceId,
      persistedOnlineFallback({
        registryPresent: true,
        parentDeviceId: m.parentDeviceId ?? null,
        config: persistedConfig,
      }),
    ),
    probed: pctx.host.resolveDeviceProbed(deviceId),
    features: persistedFeatures(m.features),
    isCamera: persistedIsCamera(m.type),
    config: persistedConfig ?? {},
    ...secretConfigPathsField(pctx.secretConfigPaths.get(deviceId)),
    metadata,
    ...(m.integrationId !== undefined ? { integrationId: m.integrationId } : {}),
    ...(m.linkDeviceId !== undefined ? { linkDeviceId: m.linkDeviceId } : {}),
    ...(m.primaryChildEntityId !== undefined
      ? { primaryChildEntityId: m.primaryChildEntityId }
      : {}),
    ...(m.childLayout !== undefined ? { childLayout: m.childLayout } : {}),
    ...(m.display !== undefined ? { display: m.display } : {}),
    // Forked-worker accessory children (e.g. HA sensor entities)
    // persist entityId + system in the config blob. Reconstruct
    // identity-only sourceInfo for dispatch routing.
    ...(sourceInfoGetDevice !== undefined ? { sourceInfo: sourceInfoGetDevice } : {}),
  }
}

/** One entry of a `getChildren` / `getChildrenBatch` answer. */
type ChildDeviceInfo = ReturnType<typeof toDeviceInfo>

/**
 * The child ids whose config comes from the SETTINGS STORE — the rows the live
 * registry does not answer for.
 *
 * The one place the "persisted fills in what the registry does not hold" rule
 * is spelled, so the pre-read and the projection cannot disagree about which
 * children need a store value. On the live hub 2026-08-30 this is every child
 * there is: all 896 belong to forked provider addons, so hub-main's registry
 * holds none of them.
 */
function persistedChildIds(
  childRows: readonly DeviceRow[],
  liveChildren: readonly IDevice[],
): readonly number[] {
  const live = new Set<number>()
  for (const device of liveChildren) live.add(device.id)
  return childRows.filter((row) => !live.has(row.meta.id)).map((row) => row.meta.id)
}

/**
 * The children of ONE parent, projected from rows, live devices AND configs the
 * caller has ALREADY read.
 *
 * Extracted so `getChildren` and `getChildrenBatch` share one projection: the
 * batch differs only in HOW the rows were fetched (one `listByParentMany`
 * instead of N `listByParent`), never in what a parent's answer looks like.
 *
 * **Not async, and that is the contract.** This function used to `await
 * pctx.settings.readDeviceStore(m.id)` inside its own loop — one settings-door
 * round trip per persisted child, sequentially, on hub-main's event loop. The
 * caller above (`getChildrenBatch`, coalescing every accessory reconcile in
 * flight) had already removed the ledger N+1 and left this one: 896 door reads
 * per boot reconcile and per device page, at ~2.9 s each mid-drain. `configs`
 * arrives resolved through `readDeviceConfigs` — one round trip for the whole
 * pass — and a signature with no `Promise` in it means a future read cannot be
 * put back here without the type saying so.
 */
function projectChildren(
  pctx: ProviderContext,
  parentDeviceId: number,
  ownerAddonId: string,
  childRows: readonly DeviceRow[],
  liveChildren: readonly IDevice[],
  configs: ReadonlyMap<number, Record<string, unknown>>,
): readonly ChildDeviceInfo[] {
  // Same union pattern as listAll: live (hub-registry) wins, persisted
  // fills in devices owned by forked workers.
  const results: ChildDeviceInfo[] = []
  const seen = new Set<string>()

  const rowById = new Map<number, DeviceRow>()
  for (const row of childRows) rowById.set(row.meta.id, row)

  for (const device of liveChildren) {
    const key = String(device.id)
    const row = rowById.get(device.id)
    results.push(toDeviceInfo(ownerAddonId, device, row?.metadata ?? null, row?.meta ?? null))
    seen.add(key)
  }

  for (const row of childRows) {
    const m = row.meta
    const childStableId = m.stableId
    const key = String(m.id)
    if (seen.has(key)) continue
    // `readDeviceConfigs` answers for every id it was given, `{}` included, so
    // an absent entry means the id was never asked for — which for a row that
    // reached this branch cannot happen, and the `?? {}` says what it costs if
    // it ever does.
    const persistedConfig = configs.get(m.id) ?? {}
    const metadata = row.metadata
    const sourceInfoChild = buildSourceInfoFromConfig(persistedConfig, childStableId, ownerAddonId)
    results.push({
      id: m.id,
      stableId: childStableId,
      addonId: ownerAddonId,
      type: m.type as DeviceType,
      name: m.name,
      location: m.location ?? null,
      disabled: m.disabled ?? false,
      parentDeviceId,
      // role is a first-class meta field — read from the persisted
      // meta row (stamped by setRole pre-seed in create()/spawnAccessoryChild).
      role: toDeviceRole(m.role),
      // Real per-device liveness from the mirrored `device-status` slice
      // the owning (forked) worker publishes via `markOnline`. Fallback
      // preserves legacy behaviour (registry===null → offline view;
      // present registry with no slice yet → online).
      online: pctx.host.resolveDeviceOnline(m.id, pctx.registry !== null),
      probed: pctx.host.resolveDeviceProbed(m.id),
      features: persistedFeatures(m.features),
      isCamera: persistedIsCamera(m.type),
      config: persistedConfig,
      ...secretConfigPathsField(pctx.secretConfigPaths.get(m.id)),
      metadata,
      ...(m.integrationId !== undefined ? { integrationId: m.integrationId } : {}),
      ...(m.linkDeviceId !== undefined ? { linkDeviceId: m.linkDeviceId } : {}),
      ...(m.primaryChildEntityId !== undefined
        ? { primaryChildEntityId: m.primaryChildEntityId }
        : {}),
      ...(m.childLayout !== undefined ? { childLayout: m.childLayout } : {}),
      ...(m.display !== undefined ? { display: m.display } : {}),
      // Forked-worker accessory children (e.g. HA sensor entities)
      // persist entityId + system in the config blob. Reconstruct
      // identity-only sourceInfo for dispatch routing.
      ...(sourceInfoChild !== undefined ? { sourceInfo: sourceInfoChild } : {}),
    })
  }
  return results
}

/**
 * Owning addonId for a parent, or `null` when the fleet does not know it.
 *
 * Children are always registered under the same addonId as their parent, so
 * the persisted-child projection is scoped by it. The live registry answers
 * for free; only a parent it does not hold costs a row read.
 */
function liveOwnerOf(pctx: ProviderContext, parentDeviceId: number): string | null {
  if (!pctx.registry) return null
  if (!pctx.registry.getById(parentDeviceId)) return null
  return pctx.registry.getAddonId(parentDeviceId)
}

export async function getChildren(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getChildren']>[0],
): ReturnType<IDeviceManagerProvider['getChildren']> {
  const { parentDeviceId } = input

  let ownerAddonId = liveOwnerOf(pctx, parentDeviceId)
  if (!ownerAddonId) {
    const persisted = await pctx.metaStore.resolvePersistedById(parentDeviceId)
    if (!persisted) return []
    ownerAddonId = persisted.addonId
  }

  // `parentDeviceId` is an indexed column, so the children ARE the query —
  // this used to be the whole fleet blob filtered in JS through the
  // `deviceIndex` list of the owning addon.
  const childRows = await pctx.metaStore.rows.listByParent(parentDeviceId)
  const liveChildren = pctx.registry?.getChildren(parentDeviceId) ?? []
  // ONE store round trip for every persisted child's config, ahead of the
  // projection — never one per child inside it. Same helper `listAll` uses.
  const configs = await readDeviceConfigs(pctx, persistedChildIds(childRows, liveChildren))
  const projected = projectChildren(
    pctx,
    parentDeviceId,
    ownerAddonId,
    childRows,
    liveChildren,
    configs,
  )
  return [...projected]
}

/**
 * `getChildren` for a set of parents — THREE store reads for the whole set, not
 * three per parent (and not one per child).
 *
 * The single-parent path costs one `resolvePersistedById` (a primary-key read)
 * plus one `listByParent` (an indexed scan) EACH. Asked once per device at
 * boot that was 1 024 of each, measured on the live hub 2026-08-27 — see the
 * cap method's note. Here the ownership lookup for every parent the live
 * registry does not hold is ONE `getMany`, and the children of every parent
 * are ONE `listByParentMany`. The third read is the settings door, and it is
 * one for the whole batch: `readDeviceConfigs` over every persisted child of
 * every parent. That one was the leftover — the ledger N+1 was removed and a
 * door round trip PER CHILD stayed behind it (896 on the live hub 2026-08-30,
 * all of them forked-owned and therefore all persisted).
 *
 * The live half is indexed once too: `registry.getChildren` is
 * `getAll().filter(…)`, so calling it per parent would trade an RPC N+1 for an
 * in-memory one — 256 full sweeps of the registry per batch. One pass over
 * `getAll()` buckets every live device by its parent instead.
 *
 * A parent with no children at all is ABSENT from the record; so is a parent
 * the fleet does not know. Same contract as `DeviceRowStore.getMany` — the
 * caller asked about it and gets no row, rather than an invented empty one it
 * cannot tell apart from a real childless parent.
 */
export async function getChildrenBatch(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getChildrenBatch']>[0],
): ReturnType<IDeviceManagerProvider['getChildrenBatch']> {
  const parentIds = [...new Set(input.parentDeviceIds)]
  const out: Record<string, ChildDeviceInfo[]> = {}
  // An empty set reads nothing at all rather than degrading to "everything".
  if (parentIds.length === 0) return out

  // Ownership: the registry answers for the parents it holds; ONE row read
  // covers all the others (forked-worker parents, or rows with no live device).
  const owners = new Map<number, string>()
  const unownedIds: number[] = []
  for (const parentId of parentIds) {
    const live = liveOwnerOf(pctx, parentId)
    if (live !== null) owners.set(parentId, live)
    else unownedIds.push(parentId)
  }
  if (unownedIds.length > 0) {
    const rows = await pctx.metaStore.rows.getMany(unownedIds)
    for (const [parentId, row] of rows) owners.set(parentId, row.meta.addonId)
  }

  const requested = new Set(parentIds)
  const rowsByParent = await pctx.metaStore.rows.listByParentMany([...owners.keys()])

  const liveByParent = new Map<number, IDevice[]>()
  for (const device of pctx.registry?.getAll() ?? []) {
    const parentId = device.parentDeviceId
    if (parentId === null || parentId === undefined) continue
    if (!requested.has(parentId)) continue
    const bucket = liveByParent.get(parentId)
    if (bucket === undefined) liveByParent.set(parentId, [device])
    else bucket.push(device)
  }

  // The third read, and the last one: every persisted child of every parent in
  // the batch, in ONE settings-door round trip. It used to be one per child
  // INSIDE `projectChildren` — 896 of them on the live hub 2026-08-30, where
  // all 896 children belong to forked provider addons and so none is answered
  // by the registry. `getChildrenBatch` had already removed the ledger N+1 and
  // stopped here; a batch that then pays a door round trip per child is a batch
  // in name only.
  const configIds: number[] = []
  for (const parentId of owners.keys()) {
    configIds.push(
      ...persistedChildIds(rowsByParent.get(parentId) ?? [], liveByParent.get(parentId) ?? []),
    )
  }
  const configs = await readDeviceConfigs(pctx, configIds)

  for (const [parentId, ownerAddonId] of owners) {
    const childRows = rowsByParent.get(parentId) ?? []
    const liveChildren = liveByParent.get(parentId) ?? []
    if (childRows.length === 0 && liveChildren.length === 0) continue
    const projected = projectChildren(
      pctx,
      parentId,
      ownerAddonId,
      childRows,
      liveChildren,
      configs,
    )
    if (projected.length > 0) out[String(parentId)] = [...projected]
  }
  return out
}

// ── Live runtime methods ──────────────────────────────────────────────

export async function getStreamSources(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getStreamSources']>[0],
): ReturnType<IDeviceManagerProvider['getStreamSources']> {
  const { deviceId } = input
  // Hub-local path
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      // Non-camera devices have no streams by definition — return
      // an empty list immediately instead of round-tripping through
      // `device-ops`. Cross-process dispatch is strictly for
      // worker-owned devices, not for wrong-type hub-local ones.
      if (!isCameraDevice(found.device)) return []
      const sources: readonly StreamSourceEntry[] = await found.device.getStreamSources()
      return sources.map((s) => ({
        id: s.id,
        label: s.label,
        protocol: s.protocol,
        url: s.url,
        resolution: s.resolution,
        fps: s.fps,
        bitrate: s.bitrate,
        codec: s.codec,
        profileHint: s.profileHint,
      }))
    }
  }
  // Cross-process fallback — dispatch through the `device-ops` native
  // provider, now keyed on the numeric id in both hub and worker.
  // Errors propagate: a transient worker error must NOT masquerade as
  // "device has no streams" — callers need the real error.
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted)
    throw userError(
      'device.not-found',
      { id: deviceId },
      `[device-manager] Device with id ${deviceId} not found`,
    )
  const ops = pctx.requireDeviceOps(deviceId)
  const sources = await ops.getStreamSources({ deviceId })
  return sources.map((s) => ({ ...s }))
}

export async function getConfigSchema(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getConfigSchema']>[0],
): ReturnType<IDeviceManagerProvider['getConfigSchema']> {
  const { deviceId } = input
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      return found.device.config.entries().map((entry) => ({
        key: entry.key,
        value: entry.value,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      }))
    }
  }
  // Cross-process fallback. Propagates the real error when the
  // owning worker is offline or the device genuinely doesn't exist —
  // surfacing "no config" silently used to let the UI render empty
  // forms for broken devices.
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted)
    throw userError(
      'device.not-found',
      { id: deviceId },
      `[device-manager] Device with id ${deviceId} not found`,
    )
  const ops = pctx.requireDeviceOps(deviceId)
  const entries = await ops.getConfigEntries({ deviceId })
  return entries.map((e) => ({ ...e }))
}

export async function getSettingsSchema(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getSettingsSchema']>[0],
): ReturnType<IDeviceManagerProvider['getSettingsSchema']> {
  const { deviceId } = input
  // Single source of truth: every IDevice implements
  // `getSettingsUISchema`. Hub-local devices answer in-process;
  // forked-worker devices go through the `device-ops.getSettingsSchema`
  // native provider which delegates to the same method worker-side.
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      return found.device.getSettingsUISchema()
    }
  }
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) return null
  const ops = pctx.requireDeviceOps(deviceId)
  const schema = await ops.getSettingsSchema({ deviceId })
  return (schema as ConfigUISchemaWithValues | null) ?? null
}

export async function updateConfig(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['updateConfig']>[0],
): ReturnType<IDeviceManagerProvider['updateConfig']> {
  const { deviceId } = input
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      await found.device.config.setAll(input.values)
      return { success: true as const }
    }
  }
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted)
    throw userError(
      'device.not-found',
      { id: deviceId },
      `[device-manager] Device with id ${deviceId} not found`,
    )
  const ops = pctx.requireDeviceOps(deviceId)
  await ops.setConfig({ deviceId, values: input.values })
  return { success: true as const }
}

// `enable` / `disable` write to deviceMeta.disabled (the canonical
// soft-disable flag that drivers consult via `BaseDevice.disabled`
// at lifecycle entrypoints, and that `toDeviceInfo` projects onto
// the wire by reading the LATEST persisted meta row — see the
// `metaRow` argument plumbed through `listAll` / `getDevice` /
// `getChildren`).
//
// Earlier these wrappers wrote `enabled: true/false` into the
// device CONFIG blob — wrong store entirely. The config write
// succeeded but the flag the rest of the system reads
// (deviceMeta) stayed unchanged, so the UI's enable/disable
// toggle appeared to do nothing. Delegating to `setDisabled`
// routes through the correct withMetaWriteLock path and emits
// the `DeviceMetaChanged` event for live invalidation.
//
// NB: `BaseDevice.disabled` is `readonly` and bound at
// construction (base-device.ts:142). Drivers that gate behaviour
// off `this.disabled` only see the value the device was
// instantiated with — flipping disabled at runtime updates the
// wire response immediately, but lifecycle gating inside the
// driver only takes effect on the next instantiation. That's
// acceptable today: the operator-facing semantic is "hide /
// mark inactive in the UI"; the heavyweight teardown semantic
// is `remove`.
export async function enable(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['enable']>[0],
): ReturnType<IDeviceManagerProvider['enable']> {
  await pctx.provider.setDisabled({
    deviceId: input.deviceId,
    disabled: false,
  })
  return { success: true as const }
}

export async function disable(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['disable']>[0],
): ReturnType<IDeviceManagerProvider['disable']> {
  await pctx.provider.setDisabled({ deviceId: input.deviceId, disabled: true })
  return { success: true as const }
}

export async function remove(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['remove']>[0],
): ReturnType<IDeviceManagerProvider['remove']> {
  const { deviceId } = input

  // Direct-children enumeration is the shared `directChildIds` helper
  // (also used by the `resetToSource` resync purge, #19).
  // Single-device teardown — the previous remove() body extracted into
  // a helper. Returns (idempotent) when the device is already gone.
  const removeOne = async (id: number): Promise<void> => {
    if (pctx.registry) {
      const live = resolveDeviceById(pctx.registry, id)
      if (live) {
        const deviceName = live.device.name
        await live.device.removeDevice()
        pctx.registry.remove(id)
        await pctx.provider.removeDevice({ deviceId: id })
        pctx.host.ctx.logger.info('removed hub-local device', {
          tags: { deviceId: id, deviceName },
        })
        return
      }
    }
    const persisted = await pctx.metaStore.resolvePersistedById(id)
    if (!persisted) return // already gone — idempotent
    const { meta: persistedMeta } = persisted
    try {
      const ops = pctx.requireDeviceOps(id)
      await ops.removeDevice({ deviceId: id })
    } catch (err) {
      // Worker might be offline or missing — still clear persistence so
      // the UI recovers. The warning is best-effort diagnostics.
      pctx.host.ctx.logger.warn('remove via device-ops failed — clearing persistence anyway', {
        tags: { deviceId: id, deviceName: persistedMeta.name },
        meta: { error: errMsg(err) },
      })
    }
    await pctx.provider.removeDevice({ deviceId: id })
  }

  // Depth-first cascade: remove descendants (leaves first), then the
  // target device itself.
  const removeCascade = async (id: number): Promise<void> => {
    for (const childId of await pctx.metaStore.directChildIds(id)) {
      await removeCascade(childId)
    }
    await removeOne(id)
  }

  await removeCascade(deviceId)
  return { success: true as const }
}

/**
 * Cascade-delete every top-level device whose `integrationId`
 * matches. Enumerates a SNAPSHOT of the meta map so concurrent
 * removals don't clobber each other. Only top-level parents are
 * enumerated — children cascade via the per-parent `removeCascade`
 * inside the delegated `remove` call. Idempotent: devices with no
 * `integrationId` never match.
 */
export async function removeByIntegration(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeByIntegration']>[0],
): ReturnType<IDeviceManagerProvider['removeByIntegration']> {
  const { integrationId } = input
  // `integrationId` is an indexed column. The snapshot is taken BEFORE the
  // first removal so a cascade that deletes children mid-iteration cannot make
  // this loop visit or skip a parent unexpectedly.
  const parents = (await pctx.metaStore.rows.listByIntegration(integrationId)).filter(
    (row) => row.meta.parentDeviceId === null,
  )
  let removed = 0
  for (const parent of parents) {
    // Use `remove` so the full cascade (children + live device teardown +
    // persistence cleanup + events) happens exactly once per parent. A parent
    // a concurrent remove already took is a no-op inside it.
    await pctx.provider.remove({ deviceId: parent.meta.id })
    removed++
  }
  return { removed }
}

export async function getStreamProfileMap(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getStreamProfileMap']>[0],
): ReturnType<IDeviceManagerProvider['getStreamProfileMap']> {
  if (!pctx.registry) return {}
  const found = resolveDeviceById(pctx.registry, input.deviceId)
  if (!found) return {}

  // Check for explicitly stored profile map first
  const storedMap: unknown = found.device.config
    .entries()
    .find((e) => e.key === '_profileMap')?.value
  if (storedMap !== undefined && typeof storedMap === 'object' && storedMap !== null) {
    return storedMap as Record<string, string>
  }

  // Derive from profileHint fields on stream sources
  if (!isCameraDevice(found.device)) return {}
  const sources: readonly StreamSourceEntry[] = await found.device.getStreamSources()
  const profileMap: Record<string, string> = {}
  for (const s of sources) {
    if (s.profileHint && s.id) {
      profileMap[s.profileHint] = s.id
    }
  }
  return profileMap
}

export async function setStreamProfileMap(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setStreamProfileMap']>[0],
): ReturnType<IDeviceManagerProvider['setStreamProfileMap']> {
  const { deviceId } = input
  if (pctx.registry) {
    const found = resolveDeviceById(pctx.registry, deviceId)
    if (found) {
      await found.device.config.setAll({ _profileMap: input.profileMap })
      return { success: true as const }
    }
  }
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted)
    throw userError(
      'device.not-found',
      { id: deviceId },
      `[device-manager] Device with id ${deviceId} not found`,
    )
  const ops = pctx.requireDeviceOps(deviceId)
  await ops.setConfig({ deviceId, values: { _profileMap: input.profileMap } })
  return { success: true as const }
}

export async function probeStreams(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['probeStreams']>[0],
): ReturnType<IDeviceManagerProvider['probeStreams']> {
  const streamProbe = pctx.host.ctx.kernel.streamProbe
  if (!streamProbe) return []

  const sources = await pctx.provider.getStreamSources({
    deviceId: input.deviceId,
  })
  const results: Array<{
    streamId: string
    width?: number
    height?: number
    codec?: string
    fps?: number
    bitrateKbps?: number
  }> = []

  for (const s of sources) {
    if (!s.url) continue
    try {
      const metadata = await streamProbe.probe(s.url, { force: true })
      results.push({
        streamId: s.id,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        fps: metadata.fps,
        bitrateKbps: metadata.bitrateKbps,
      })
    } catch (err) {
      pctx.host.ctx.logger.debug('streamProbe.probe failed — returning placeholder', {
        meta: {
          deviceId: input.deviceId,
          streamId: s.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      results.push({ streamId: s.id })
    }
  }

  return results
}

// ── Device-provider operations (routed via CapabilityRegistry) ───────

export async function discoverDevices(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['discoverDevices']>[0],
): ReturnType<IDeviceManagerProvider['discoverDevices']> {
  const dp = await pctx.host.requireDeviceProvider(input.addonId)

  const supported = await dp.supportsDiscovery({})
  if (!supported) {
    throw userError(
      'system.addon-no-discovery',
      { addonId: String(input.addonId) },
      `Addon "${input.addonId}" does not support device discovery`,
    )
  }

  const discovered = await dp.discoverDevices({})
  // Field-by-field so the wire shape is explicit — but every field a provider
  // sets must be listed. `alreadyOnboarded` was invisible to the operator for
  // exactly as long as this projection dropped it.
  return discovered.map((d) => ({
    stableId: d.stableId,
    type: d.type,
    suggestedName: d.suggestedName,
    prefilledConfig: d.prefilledConfig,
    ...(d.alreadyOnboarded === true ? { alreadyOnboarded: true } : {}),
    ...(d.onboardedDeviceId !== undefined ? { onboardedDeviceId: d.onboardedDeviceId } : {}),
    ...(d.onboardedName !== undefined ? { onboardedName: d.onboardedName } : {}),
  }))
}

export async function adoptDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptDevice']>[0],
): ReturnType<IDeviceManagerProvider['adoptDevice']> {
  const dp = await pctx.host.requireDeviceProvider(input.addonId)

  const supported = await dp.supportsDiscovery({})
  if (!supported) {
    throw userError(
      'system.addon-no-adoption',
      { addonId: String(input.addonId) },
      `Addon "${input.addonId}" does not support device adoption`,
    )
  }

  // Same operator-action bypass as `createDevice` (D376).
  const summary = await pctx.removalFence.runUnfenced(() =>
    dp.adoptDiscoveredDevice({
      candidate: input.candidate as Parameters<
        IDeviceProviderCap['adoptDiscoveredDevice']
      >[0]['candidate'],
    }),
  )
  if (input.integrationId !== undefined) {
    try {
      await pctx.stampIntegrationId(summary.id, input.integrationId)
    } catch (err) {
      pctx.host.ctx.logger.warn('adoptDevice: integrationId stamp failed (device adopted)', {
        tags: { deviceId: summary.id, integrationId: input.integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }
  return summary
}

export async function getCreationSchema(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getCreationSchema']>[0],
): ReturnType<IDeviceManagerProvider['getCreationSchema']> {
  const dp = await pctx.host.requireDeviceProvider(input.addonId)

  const supported = await dp.supportsManualCreation({})
  if (!supported) return null

  const schema = await dp.getChildCreationSchema({ type: input.type })
  return schema ?? null
}

export async function createDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['createDevice']>[0],
): ReturnType<IDeviceManagerProvider['createDevice']> {
  const dp = await pctx.host.requireDeviceProvider(input.addonId)

  const supported = await dp.supportsManualCreation({})
  if (!supported) {
    throw userError(
      'system.addon-no-manual-create',
      { addonId: String(input.addonId) },
      `Addon "${input.addonId}" does not support manual device creation`,
    )
  }

  // An operator re-adding hardware they just deleted must not meet the
  // removal fence (D376) — the provider derives the stableId, so the whole
  // fence comes down for the duration of the operator's own action.
  const summary = await pctx.removalFence.runUnfenced(() =>
    dp.createDevice({
      type: input.type,
      config: input.config,
    }),
  )
  if (input.integrationId !== undefined) {
    try {
      await pctx.stampIntegrationId(summary.id, input.integrationId)
    } catch (err) {
      pctx.host.ctx.logger.warn('createDevice: integrationId stamp failed (device created)', {
        tags: { deviceId: summary.id, integrationId: input.integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }
  return summary
}

export async function testCreationField(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['testCreationField']>[0],
): ReturnType<IDeviceManagerProvider['testCreationField']> {
  const dp = await pctx.host.requireDeviceProvider(input.addonId)
  return dp.testCreationField({
    type: input.type,
    key: input.key,
    value: input.value,
    ...(input.formValues !== undefined ? { formValues: input.formValues } : {}),
  })
}

// ── Device-adoption operations (routed via CapabilityRegistry) ───────

export async function adoptionListCandidates(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionListCandidates']>[0],
): ReturnType<IDeviceManagerProvider['adoptionListCandidates']> {
  const { addonId, ...rest } = input
  const adoptionProvider = await pctx.host.requireDeviceAdoptionProvider(addonId)
  return adoptionProvider.listCandidates(rest)
}

export async function adoptionRefresh(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionRefresh']>[0],
): ReturnType<IDeviceManagerProvider['adoptionRefresh']> {
  const { addonId, integrationId } = input
  const adoptionProvider = await pctx.host.requireDeviceAdoptionProvider(addonId)
  return adoptionProvider.refresh({ integrationId })
}

export async function adoptionAdopt(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionAdopt']>[0],
): ReturnType<IDeviceManagerProvider['adoptionAdopt']> {
  const { addonId, ...rest } = input
  const adoptionProvider = await pctx.host.requireDeviceAdoptionProvider(addonId)
  return adoptionProvider.adopt(rest)
}

export async function adoptionRelease(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionRelease']>[0],
): ReturnType<IDeviceManagerProvider['adoptionRelease']> {
  const { addonId, ...rest } = input
  const adoptionProvider = await pctx.host.requireDeviceAdoptionProvider(addonId)
  return adoptionProvider.release(rest)
}

// ── Background adoption jobs ─────────────────────────────────────────
//
// `adoptionAdopt` above puts the whole `childNativeIds` array behind ONE UDS
// request deadline. These three drive the same provider through
// `AdoptionJobEngine`, one candidate per call, so nothing the operator selects
// — nor anything the source system fans out into — can exceed the deadline.

export async function adoptionStartJob(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionStartJob']>[0],
): ReturnType<IDeviceManagerProvider['adoptionStartJob']> {
  const { addonId, integrationId, childNativeIds, filter, importLocations, perCandidate } = input
  return pctx.host.adoptionJobs.start({
    addonId,
    integrationId,
    childNativeIds,
    ...(filter !== undefined ? { filter } : {}),
    ...(importLocations !== undefined ? { importLocations } : {}),
    ...(perCandidate !== undefined ? { perCandidate } : {}),
  })
}

export async function adoptionListJobs(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionListJobs']>[0],
): ReturnType<IDeviceManagerProvider['adoptionListJobs']> {
  const { addonId, integrationId } = input
  return pctx.host.adoptionJobs.list({
    addonId,
    ...(integrationId !== undefined ? { integrationId } : {}),
  })
}

export async function adoptionCancelJob(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionCancelJob']>[0],
): ReturnType<IDeviceManagerProvider['adoptionCancelJob']> {
  return { cancelled: pctx.host.adoptionJobs.cancel(input.jobId) }
}

export async function adoptionResync(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['adoptionResync']>[0],
): ReturnType<IDeviceManagerProvider['adoptionResync']> {
  const { camDeviceId, resetToSource } = input
  // Route to the OWNING addon's adoption provider (resolved from the
  // device id) — never the singleton, which would hit the wrong integration.
  let owningAddonId = pctx.registry?.getAddonId(camDeviceId) ?? null
  if (!owningAddonId) {
    const persisted = await pctx.metaStore.resolvePersistedById(camDeviceId)
    owningAddonId = persisted?.addonId ?? null
  }
  if (!owningAddonId) {
    throw new Error(`adoptionResync: device ${camDeviceId} not found`)
  }
  // "Resync from zero" (#19): tear down every accessory child of the
  // parent BEFORE the provider re-derives it, so children rebuild fresh
  // from source (correct names/coords/units) instead of being preserved by
  // the incremental reconcile + frozen by the name-precedence rule (#17).
  // The parent itself (and its operator edits — name, layout, primary-child
  // pick) is untouched. Each child is removed via the public `remove`
  // action, which cascades that child's own subtree (live + persisted +
  // device-ops teardown). Push-driven providers (no-op resync) rebuild on
  // their next snapshot; pull/command providers rebuild inside `resync`.
  let removedChildren = 0
  if (resetToSource === true) {
    const childIds = await pctx.metaStore.directChildIds(camDeviceId)
    for (const childId of childIds) {
      await pctx.provider.remove({ deviceId: childId })
      removedChildren += 1
    }
    pctx.host.ctx.logger.info('resetToSource purge before resync', {
      tags: { deviceId: camDeviceId, removedChildren },
    })
  }
  const adoptionProvider = await pctx.host.requireDeviceAdoptionProvider(owningAddonId)
  const result = await adoptionProvider.resync({ camDeviceId, resetToSource })
  return { ...result, removedChildren }
}

export async function testField(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['testField']>[0],
): ReturnType<IDeviceManagerProvider['testField']> {
  const { deviceId } = input
  let owningAddonId: string | null = null
  if (pctx.registry) {
    owningAddonId = pctx.registry.getAddonId(deviceId)
  }
  if (!owningAddonId) {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    owningAddonId = persisted?.addonId ?? null
  }
  if (!owningAddonId) {
    throw userError('device.not-found', { id: deviceId }, `Device with id ${deviceId} not found`)
  }

  const dp = await pctx.host.waitDeviceProvider(owningAddonId)
  if (!dp) {
    return { status: 'ok' as const, labels: [], error: undefined }
  }

  if (typeof (dp as Record<string, unknown>).testCreationField !== 'function') {
    return { status: 'ok' as const, labels: [], error: undefined }
  }

  return dp.testCreationField({
    type: DeviceType.Camera,
    key: input.key,
    value: input.value,
  })
}

// ── Bindings — per-device capability provider map ────────────────────
