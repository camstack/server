import { clearDeviceSettings } from '../../kernel/device-settings-store.js'
import { userError } from '@camstack/types'
/**
 * Device meta-mutation + persistence actions for the device-manager addon —
 * the `IDeviceManagerProvider` write/load surface. Extracted verbatim from the
 * `onInitialize` provider literal as free functions taking a `ProviderContext`
 * (DI). Each function's input/return types are pinned to the cap contract via
 * `Parameters<IDeviceManagerProvider['x']>[0]` / `ReturnType<…>` so the typed
 * surface is identical to the inferred object-literal methods.
 *
 * Covers: id allocation + registration (allocateDeviceId, registerDevice,
 * removeDevice), config persistence (persistConfig, loadConfig), the meta
 * surface load (loadMeta, loadRuntimeState), every meta setter (setName,
 * setLocation, setType, setIntegrationId, setLinkDeviceId,
 * setPrimaryChildEntityId, setChildLayout, setRole, setDisplay,
 * applyInitialMeta, setMetadata, setDisabled), and the location registry
 * (listLocations, addLocation, removeLocation, renameLocation) with its icon
 * map (listLocationIcons, setLocationIcon).
 *
 * EXACT ordering and side effects preserved — notably registerDevice's
 * name-precedence reconcile + field-preservation spreads, the
 * withMetaWriteLock-serialised read-modify-writes, the event emissions, and the
 * link reverse-index rebuild gating. Pure refactor — no behavior change.
 */
import { randomUUID } from 'node:crypto'
import { migrateDevice as runMigrateDevice } from './migrate-device.js'
import { reloadMigratedDevices } from './migrate-reload.js'
import {
  assertNoClaimLandedDuringMigration,
  assertNoFieldClaims,
  ClaimLandedDuringMigrationError,
  FieldClaimsBlockMigrationError,
  swapHardwareState,
} from './migrate-hardware-state.js'
import type { AddonContext } from '@camstack/types'
import {
  type DeviceCapDisplayOverride,
  type DeviceDisplayOverride,
  DeviceType,
  deviceManagerCapability,
  EventCategory,
  InferProvider,
  type IconKey,
  locationIconKey,
  normalizeUnit,
  type RoleDisplayDefault,
  siteZoneKey,
} from '@camstack/types'
import { canonicalDeviceFingerprint } from '@camstack/types/node'
import { readBindingsStore, writeBindingsStore } from './device-bindings-store.js'
import {
  loadDeviceConfigWithSecrets,
  persistDeviceConfigWithSecrets,
} from './device-config-secrets.js'
import type { DeviceMetaStore } from './device-meta-store.js'
import { resolveInheritedLocation } from './location-alignment.js'
import type { PersistedDeviceMeta, SiteZoneRecord } from './device-meta-types.js'
import type { ProviderContext } from './device-provider-context.js'
import { removalHookStep } from './device-removal-hooks.js'
import type { RemovalStep } from './removal-cleanup.js'
import type { MirrorWriteHold } from './mirror-row-writer.js'
import { splitRuntimeBlob } from './field-ownership.js'

type IDeviceManagerProvider = InferProvider<typeof deviceManagerCapability>

/** The mirror write hold a migration takes at `swapIds` and releases when its body ends. */
interface MirrorHoldSlot {
  current: MirrorWriteHold | null
}

/**
 * Stamp (or update) the owning integration id on a device's meta row + emit
 * `DeviceMetaChanged`. The device-manager chokepoint shared by the
 * `setIntegrationId` cap handler AND the create/adopt forwarders (queries)
 * that stamp an integration's ownership onto every device it materializes.
 * Idempotent. Takes its low-level deps directly (not the full `ProviderContext`)
 * because `ProviderContext.stampIntegrationId` delegates HERE — passing the
 * context would be a capture cycle.
 */
export async function stampIntegrationId(
  metaStore: DeviceMetaStore,
  ctx: AddonContext,
  deviceId: number,
  integrationId: string,
): Promise<void> {
  await metaStore.withMetaWriteLock(async () => {
    const persisted = await metaStore.resolvePersistedById(deviceId)
    if (!persisted)
      throw new Error(`[device-manager] stampIntegrationId: unknown device id=${deviceId}`)
    await metaStore.rows.patch(deviceId, { integrationId })
  })
  ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'integrationId', value: integrationId },
  })
}

export async function allocateDeviceId(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['allocateDeviceId']>[0],
): ReturnType<IDeviceManagerProvider['allocateDeviceId']> {
  const { addonId, stableId } = input
  return await pctx.metaStore.withMetaWriteLock(async () => {
    // `(addonId, stableId)` is the addon-facing identity and it is an INDEXED
    // pair on the row (`idx_dm_devices_addon_stable`) — the fleet scan this
    // used to be is gone with the blob it scanned.
    const existing = await pctx.metaStore.rows.findByStableId(addonId, stableId)
    if (existing) return { id: existing.meta.id }
    // The device was just REMOVED. Minting a fresh row here is how a deleted
    // camera came back as a shell (D376): the removal cleared the config, and
    // nothing this path writes can put it back. An operator re-adding the same
    // hardware goes through `createDevice`/`adoptDevice`, which lift the fence
    // first — so this refusal only ever hits a write that was already in
    // flight when the operator pressed delete.
    const fenced = pctx.removalFence.isPairFenced(addonId, stableId)
    if (fenced) {
      pctx.host.ctx.logger.warn(
        'allocateDeviceId refused — this device was just removed, NOT re-created',
        { tags: { deviceId: fenced.deviceId }, meta: { addonId, stableId } },
      )
      throw new Error(
        `[device-manager] allocateDeviceId: device ${fenced.deviceId} (${addonId}/${stableId}) was removed — refusing to re-create it`,
      )
    }
    const id = await pctx.metaStore.allocateNextDeviceId()
    await pctx.metaStore.rows.upsert(
      {
        addonId,
        stableId,
        type: 'generic',
        name: stableId,
        location: null,
        disabled: false,
        parentDeviceId: null,
        id,
      },
      // NOT registered: `registerDevice` has not run. This is the bit the
      // former `deviceIndex` carried, and `registerDevice` reads it to tell a
      // FIRST registration (emit `DeviceRegistered`) from a meta refresh.
      { registered: false, metadata: null },
    )
    return { id }
  })
}

/**
 * Replace a camera: the new hardware inherits the number the system knows.
 *
 * The composition lives in `migrate-device.ts`, deliberately free of this
 * file's context so the decisions it carries — above all "never report a switch
 * as off when it could not be written" — are testable without a hub. This is
 * the wiring: the real dependencies, and the write lock.
 *
 * The temp id comes from `allocateNextDeviceId`, the monotonic counter, so the
 * value a crash could park a row on was never used and will never be reused.
 * `swapIds` therefore runs INSIDE the same lock the id was allocated under.
 *
 * Retry-safe since 2026-09-04 (`migrate-guard.ts`): a concurrent call touching
 * either device is REFUSED before it can queue on the lock, and a repeat of a
 * completed swap — matched against the `addonId`/`stableId` fingerprint the
 * swap left on the rows — is a no-op returning the original report. A client
 * retry ran a second full cycle on 2026-09-01 and swapped two cameras back;
 * neither path can re-run a swap any more.
 */
export async function migrateDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['migrateDevice']>[0],
): ReturnType<IDeviceManagerProvider['migrateDevice']> {
  const { sourceId, targetId } = input
  const ctx = pctx.host.ctx
  // Claim both ids BEFORE queueing on the write lock. The lock is FIFO: a
  // retry that merely queued would park behind the running migration and
  // re-swap the identities the moment it finishes — which is exactly what a
  // client's automated retry did on 2026-09-01 after its own timeout expired
  // mid-migration. A concurrent call touching either device is refused, loudly.
  pctx.migrationGuard.begin(sourceId, targetId)
  try {
    const outcome = await pctx.metaStore.withMetaWriteLock(async () => {
      // BOTH rows are resolved before a single switch is written.
      //
      // Without this the disable phase runs first and the swap discovers the
      // problem afterwards: a typo in the target id would leave the SOURCE with
      // every function turned off and no migration performed — the camera goes
      // dark and nothing happened. Verified live on 2026-09-02, where a probe
      // with two nonexistent ids reached `swapIds` having already MUTED
      // notifications for both (`mutedCameras=2`), a write the mute authority
      // accepted for devices that do not exist.
      //
      // `swapIds` refuses the same cases; this is not that check moved, it is
      // the same check made EARLY, so the refusal costs nothing instead of
      // costing the source camera its functions.
      const sourceRow = await pctx.metaStore.rows.get(sourceId)
      if (sourceRow === null) {
        throw new Error(`[device-manager] migrateDevice: device ${sourceId} does not exist`)
      }
      const targetRow = await pctx.metaStore.rows.get(targetId)
      if (targetRow === null) {
        throw new Error(`[device-manager] migrateDevice: device ${targetId} does not exist`)
      }

      // A repeat of a swap that already COMPLETED is a no-op returning the
      // original report. The rows answer "did this already run": the recorded
      // fingerprint must still sit on both numbers. A blind re-run here would
      // silently undo the previous migration — the near-miss of 2026-09-01.
      const replay = pctx.migrationGuard.matchReplay(
        sourceId,
        targetId,
        { addonId: sourceRow.meta.addonId, stableId: sourceRow.meta.stableId },
        { addonId: targetRow.meta.addonId, stableId: targetRow.meta.stableId },
      )
      if (replay !== null) {
        ctx.logger.info(
          'migrateDevice: this swap already completed — replaying the original report, NOTHING re-run',
          { tags: { deviceId: sourceId }, meta: { sourceId, targetId } },
        )
        return { result: replay, reloadTargets: null }
      }

      const tempId = await pctx.metaStore.allocateNextDeviceId()
      // The mirror's debounced writer, held off both rows from just before the
      // rows move until the migration body is done (D663 re-review N-6): a
      // write that read the OLD hardware's blob and lands after the swap puts
      // the other box's state back under the number — and becomes the
      // baseline a restart restores. Changes while held are written on release.
      const held: MirrorHoldSlot = { current: null }
      const result = await runMigrateDevice(
        {
          setSwitch: async (deviceId, switchId, enabled) => {
            // The `stream-broker` switch's authority IS this addon
            // (`deviceManager.setDisabled`, D62). Routing it through
            // `pipelineOrchestrator.setCameraSwitch` sends it over UDS back
            // into this process, where it queues on the SAME meta write lock
            // this migration holds for its whole run — a self-deadlock the
            // transport resolved at its 60 s default, once per phase: measured
            // 2026-09-01, three phases burned three minutes on a migration
            // whose real work is under a second. Worse, the timed-out write
            // still LANDED once the lock released — after the swap, against
            // whichever hardware then wore the number. The flag is ours and
            // the lock is already held, so write it here: honest (`off` means
            // it moved), instant, and nothing ghost-lands later.
            if (switchId === 'stream-broker') {
              const moved = await writeDisabledFlagUnderLock(pctx, deviceId, !enabled)
              emitDisabledEvents(pctx, deviceId, !enabled, moved)
              return
            }
            await ctx.api.pipelineOrchestrator.setCameraSwitch.mutate({
              deviceId,
              switchId,
              enabled,
            })
          },
          swapIds: async (a, b) => {
            // Drained BEFORE the rows move: a drain write that fails refuses the
            // migration with nothing swapped, never with rows swapped and the
            // runtime state not.
            held.current = await pctx.host.holdMirrorWrites([a, b], pctx.settings)
            // A claim that slipped past `assertNoFieldClaims` (its write-through
            // still in flight then) is in the mirror by now, and none can reach
            // it while held (D663 final review I-1). Refused as nothing-moved:
            // both cameras' switches are restored.
            try {
              assertNoClaimLandedDuringMigration((id) => pctx.host.mirrorOwnedCaps(id), a, b)
            } catch (err: unknown) {
              if (err instanceof ClaimLandedDuringMigrationError) {
                for (const blocked of err.blocked) {
                  ctx.logger.warn('migrateDevice refused: a claim landed during the migration', {
                    tags: { deviceId: blocked.deviceId },
                    meta: { sourceId: a, targetId: b, claims: blocked.claims },
                  })
                }
              }
              throw err
            }
            await pctx.metaStore.rows.swapIds(a, b, tempId)
          },
          assertNoFieldClaims: async (a, b) => {
            try {
              await assertNoFieldClaims(pctx.settings, a, b)
            } catch (err: unknown) {
              // One line per claimed device, tagged with ITS id (D391): the
              // operator asks "why won't 4362 migrate", not "why won't 618".
              if (err instanceof FieldClaimsBlockMigrationError) {
                for (const blocked of err.blocked) {
                  ctx.logger.warn('migrateDevice refused: fields claimed by a customization', {
                    tags: { deviceId: blocked.deviceId },
                    meta: { sourceId: a, targetId: b, claims: blocked.claims },
                  })
                }
              }
              throw err
            }
          },
          swapHardwareState: async (a, b) => {
            const swapped = await swapHardwareState(pctx.settings, a, b)
            // Reseed the hub's runtime-state mirror so a read landing before the
            // respawn answers from the hardware now wearing each number, not the
            // one that left it. `replace`, not the boot path's fill-gaps: every
            // slice memory holds under these numbers is the OTHER hardware's.
            pctx.host.seedMirror(
              a,
              pctx.host.withResetSessionProbe(swapped.runtimeStateNowAtSource),
              'replace',
            )
            pctx.host.seedMirror(
              b,
              pctx.host.withResetSessionProbe(swapped.runtimeStateNowAtTarget),
              'replace',
            )
            ctx.logger.info('migration: hardware-scoped device state swapped', {
              tags: { deviceId: a },
              meta: {
                sourceId: a,
                targetId: b,
                hardwareKeysToSource: swapped.hardwareKeysToSource,
                hardwareKeysToTarget: swapped.hardwareKeysToTarget,
                roleKeysKeptAtSource: swapped.roleKeysKeptAtSource,
                roleKeysKeptAtTarget: swapped.roleKeysKeptAtTarget,
              },
            })
          },
          // Through the broker's own cap, not `setStreamProfileMap`: the device
          // config `_profileMap` key is the LEGACY spelling nobody reads any
          // more (the admin UI writes `streamBroker.assignProfile` directly —
          // see `StreamsTab.tsx`), so clearing it would have fixed nothing. The
          // stale `mid → native:slot-3` observed live sat in the broker's own
          // assignment map, and only the broker can purge it together with the
          // derived streams, probe snapshots and token rows that describe the
          // old hardware.
          forgetStreamState: async (deviceId) => {
            await ctx.api.streamBroker.forgetDeviceHardware.mutate({
              deviceId,
            })
          },
          log: (message, meta) => {
            ctx.logger.info(message, { tags: { deviceId: sourceId }, meta })
          },
          // The deprecated group read is the one surface that answers every
          // switch's state at once — the same shim `setCameraSwitch` writes
          // through, so what is read here is what a restore writes back. A
          // read, so it never queues on the meta write lock this holds.
          readSwitches: async (deviceId) => {
            const group = await ctx.api.pipelineOrchestrator.getCameraSwitches.query({ deviceId })
            return new Map(
              group.switches.filter((sw) => sw.available).map((sw) => [sw.id, sw.enabled]),
            )
          },
          logDevice: (level, deviceId, message, meta) => {
            ctx.logger[level](message, { tags: { deviceId }, meta })
          },
        },
        { sourceId, targetId },
      ).finally(() => held.current?.release())

      // The fingerprint the swap left on the rows: the pre-swap target
      // identity now sits at `sourceId` and vice versa. Recorded so a retry
      // arriving after completion replays the report instead of undoing the
      // swap.
      pctx.migrationGuard.recordCompleted({
        sourceId,
        targetId,
        identityAtSource: {
          addonId: targetRow.meta.addonId,
          stableId: targetRow.meta.stableId,
        },
        identityAtTarget: {
          addonId: sourceRow.meta.addonId,
          stableId: sourceRow.meta.stableId,
        },
        result,
      })
      return {
        result,
        // The identity now at each number — what the post-lock flush reloads.
        reloadTargets: [
          {
            deviceId: sourceId,
            addonId: targetRow.meta.addonId,
            stableId: targetRow.meta.stableId,
          },
          {
            deviceId: targetId,
            addonId: sourceRow.meta.addonId,
            stableId: sourceRow.meta.stableId,
          },
        ] as const,
      }
    })

    // Flush every live copy of the two migrated numbers — AFTER the lock, by
    // necessity, not preference: the reload dials back into this addon
    // (`allocateDeviceId`, `registerDevice`, both take the meta write lock),
    // so running it inside the critical section would be the same
    // self-deadlock the stream-broker switch had. The in-flight guard still
    // covers this phase — a retry arriving mid-reload is refused. A replay
    // (`reloadTargets: null`) reloads nothing: the rows did not change.
    if (outcome.reloadTargets !== null) {
      await reloadMigratedDevices(pctx, outcome.reloadTargets)
    }
    return outcome.result
  } finally {
    pctx.migrationGuard.end(sourceId, targetId)
  }
}

export async function registerDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['registerDevice']>[0],
): ReturnType<IDeviceManagerProvider['registerDevice']> {
  const { addonId, stableId, id, type, name, parentDeviceId, features, config } = input

  const featuresArr = Array.isArray(features) ? [...features] : []

  // A removal is final. `upsertRegistration` doubles as the INSERT for a row
  // that does not exist, so a late register from a device object whose runner
  // had not finished tearing down silently RE-CREATED the row the operator had
  // just deleted — with its name and type intact and its config gone, because
  // this path does not write config. That shell is device 105 (D376).
  const fencedRegistration =
    pctx.removalFence.isIdFenced(id) ?? pctx.removalFence.isPairFenced(addonId, stableId)
  if (fencedRegistration) {
    pctx.host.ctx.logger.warn('registerDevice refused — this device was removed, NOT resurrected', {
      tags: { deviceId: id },
      meta: { addonId, stableId },
    })
    throw new Error(
      `[device-manager] registerDevice: device ${id} (${addonId}/${stableId}) was removed — refusing to resurrect it`,
    )
  }
  // D783 — the runner's latest report of the paths its config schema declares
  // secret. An older runner sends none: keep whatever was known, the keyword
  // backstop covers the rest.
  if (Array.isArray(input.secretConfigPaths))
    pctx.secretConfigPaths.set(id, input.secretConfigPaths)

  // Read + reconcile + write under the lock so a concurrent writer on the SAME
  // row (a `setName`, a second `registerDevice`) cannot land between the read
  // and the write and lose its patch.
  const {
    isFirstRegistration,
    exportFingerprint,
    fingerprintChanged,
    inheritedLocation,
    inheritedDescendantIds,
    inheritFailed,
  } = await pctx.metaStore.withMetaWriteLock(async () => {
    // Persist the full meta record. The kernel's `create()`
    // shortcut writes operator-supplied `name` + `location`
    // BEFORE construction via `setName` / `setLocation` actions,
    // so by the time we land here the placeholder name is already
    // overwritten. Preserve every operator-edited field; the
    // `name` arg coming through this action is the device's
    // construction-time `device.name` which already reflects
    // whatever the meta row carries (`BaseDevice` reads from
    // `ctx.deviceMeta.name`).
    const existingRow = await pctx.metaStore.rows.get(id)
    const existingMeta = existingRow?.meta
    // `registered` is what `deviceIndex` membership used to mean: has
    // `registerDevice` ever run for this device? `allocateDeviceId` writes a
    // row WITHOUT registering, so row existence alone cannot answer it — and
    // getting that wrong swallows the `DeviceRegistered` event of every
    // device the kernel's `create()` flow mints.
    const wasRegistered = existingRow?.registered ?? false
    // Name-precedence (#17 `userNamed`). Preserve the operator's name
    // ONLY when the device is user-named; otherwise adopt the fresh
    // provider/construction-time `name` so an improved auto-name
    // propagates instead of being frozen forever. Legacy rows that
    // predate the flag default to user-named whenever they carry a
    // non-placeholder name (PRESERVE — never reset a possible manual
    // rename); only the literal `name === stableId` placeholder is
    // treated as auto and adopts the fresh name. The decision is then
    // STAMPED (`userNamed` below) so subsequent reconciles are explicit
    // and auto-children keep self-healing.
    const wasUserNamed =
      existingMeta?.userNamed ?? (existingMeta !== undefined && existingMeta.name !== stableId)
    const resolvedName = wasUserNamed && existingMeta !== undefined ? existingMeta.name : name
    // First registration vs subsequent meta refresh (e.g. post-probe
    // features update). Drives whether we emit a `DeviceRegistered`
    // event below — listeners (ReolinkHub discovery refresh, etc)
    // must not re-fire on every meta update or downstream work
    // multiplies.
    const isFirst = !existingMeta || !wasRegistered
    // Export-relevant fingerprint — drives the DeviceProvisioned signal
    // (emitted below only when it actually changes vs the persisted one).
    const fingerprint = canonicalDeviceFingerprint({
      deviceId: id,
      deviceType: type,
      features: featuresArr,
    })
    // Write-time location inheritance (D352): a child adopted AFTER its
    // container's location was set is the cascade's retroactivity hole
    // reopened at adoption time — the cascade fires only on `setLocation`,
    // and nobody re-saves a container because HA grew an entity. So a
    // location-less row being adopted (first registration, or re-parented)
    // inherits the nearest located CONTAINER ancestor's location HERE, on its
    // own column — never resolved by a reader at read time (D252/D329 stand).
    // Container-only, deliberately: a child adopted under a located CAMERA is
    // already linked structurally to that camera, and the room on its own
    // column would make it a location-match companion of every OTHER camera
    // in the room (see `resolveInheritedLocation` for the verified evidence).
    // Fill-null-only: a row that already carries a location keeps it, only
    // an operator's `setLocation` may overwrite. Gated on first-registration
    // / re-parent so a routine post-probe re-register of a deliberately
    // location-less subtree never pays the ancestor walk.
    const priorLocation = existingMeta?.location ?? null
    const resolvedParentId = parentDeviceId ?? null
    const parentChanged =
      existingMeta !== undefined && (existingMeta.parentDeviceId ?? null) !== resolvedParentId
    const shouldInherit =
      priorLocation === null && resolvedParentId !== null && (isFirst || parentChanged)
    const inherited = shouldInherit
      ? await resolveInheritedLocation(pctx.metaStore.rows, resolvedParentId)
      : null
    // ONE row write. Every operator-edited field the blob shape had to
    // re-state to avoid clobbering it (`integrationId`, `linkDeviceId`,
    // `primaryChildEntityId`, `childLayout`, `role`, `display`, `metadata`)
    // is simply NOT NAMED here: the statement lists its columns, so
    // preservation is the default rather than a spread somebody has to
    // remember to add.
    await pctx.metaStore.rows.upsertRegistration({
      deviceId: id,
      addonId,
      stableId,
      type,
      // Name + user-named flag resolved above (#17). `resolvedName`
      // preserves an operator rename and otherwise takes the fresh
      // provider name; `wasUserNamed` stamps the decision durably.
      name: resolvedName,
      userNamed: wasUserNamed,
      location: priorLocation ?? inherited,
      disabled: existingMeta?.disabled ?? false,
      parentDeviceId: resolvedParentId,
      registered: true,
      features: featuresArr,
      exportFingerprint: fingerprint,
    })
    // Out-of-order adoption registers children before their parents: this
    // device's own already-registered descendants missed the location it
    // just inherited. Pull it down onto their null `location` columns now,
    // in the same critical section — the same fill-null-only rule as above.
    const descendantsFilled: number[] = []
    const descendantsFailed: Array<{ id: number; error: unknown }> = []
    if (inherited !== null) {
      for (const descendant of await collectDescendants(pctx.metaStore, id)) {
        if (descendant.location !== null) continue
        try {
          await pctx.metaStore.rows.patch(descendant.id, { location: inherited })
          descendantsFilled.push(descendant.id)
        } catch (err) {
          descendantsFailed.push({ id: descendant.id, error: err })
        }
      }
    }
    return {
      isFirstRegistration: isFirst,
      exportFingerprint: fingerprint,
      fingerprintChanged: existingMeta?.exportFingerprint !== fingerprint,
      inheritedLocation: inherited,
      inheritedDescendantIds: descendantsFilled,
      inheritFailed: descendantsFailed,
    }
  })

  // Config is pre-persisted by the kernel's `create()` shortcut
  // via `persistConfig` BEFORE construction. We still accept a
  // non-empty `config` payload here for back-compat with paths
  // that haven't migrated, and write it through — but the
  // canonical CREATE path passes `config: {}` and the persisted
  // row stays untouched.
  if (Object.keys(config).length > 0) {
    await pctx.settings.writeDeviceStore(id, config)
  }

  pctx.metaStore.idToAddonId.set(id, addonId)

  // Inherited-location fallout (D352): same contract as `setLocation`'s
  // cascade — one `DeviceMetaChanged` per row actually written (the device
  // itself plus every descendant filled), one device-tagged log line, and a
  // partial failure that is never indistinguishable from a clean pass.
  if (inheritedLocation !== null) {
    for (const changedId of [id, ...inheritedDescendantIds]) {
      pctx.host.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'device', id: changedId },
        category: EventCategory.DeviceMetaChanged,
        data: { deviceId: changedId, field: 'location', value: inheritedLocation },
      })
    }
    pctx.host.ctx.logger.info('registerDevice: inherited located-ancestor location', {
      tags: { deviceId: id },
      meta: { location: inheritedLocation, descendantsFilled: inheritedDescendantIds.length },
    })
    if (inheritFailed.length > 0) {
      pctx.host.ctx.logger.error(
        'registerDevice: inherited-location fill partially failed — some descendants NOT aligned',
        {
          tags: { deviceId: id },
          meta: {
            location: inheritedLocation,
            failedIds: inheritFailed.map((f) => f.id),
            errors: inheritFailed.map((f) =>
              f.error instanceof Error ? f.error.message : String(f.error),
            ),
          },
        },
      )
    }
  }

  // Emit `DeviceRegistered` ONLY on first registration. Subsequent
  // calls (driver re-publishing post-probe features, accessory
  // count update, …) are silent meta refreshes — listeners that
  // care about the device existing already saw the first event.
  // Skipping the duplicate prevents listeners like ReolinkHub from
  // burning a discovery-refresh roundtrip per re-register.
  if (isFirstRegistration) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id },
      category: EventCategory.DeviceRegistered,
      data: {
        deviceId: id,
        name: name.length > 0 ? name : stableId,
        providerId: addonId,
        parentDeviceId: parentDeviceId ?? null,
      },
    })
  } else {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id },
      category: EventCategory.DeviceMetaChanged,
      data: {
        deviceId: id,
        name: name.length > 0 ? name : stableId,
        providerId: addonId,
        parentDeviceId: parentDeviceId ?? null,
        features: featuresArr,
      },
    })
  }

  // Export trigger: emit DeviceProvisioned ONLY when the export-relevant
  // shape (deviceType + persisted features) is new or has changed, so
  // export adapters reconcile with one clean delta instead of reacting to
  // the chatty per-cap DeviceBindingsChanged.
  if (isFirstRegistration || fingerprintChanged) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id },
      category: EventCategory.DeviceProvisioned,
      data: { deviceId: id, fingerprint: exportFingerprint, generation: Date.now() },
    })
  }
}

/**
 * The stores device-manager (or the keychain, for secrets) keeps for a device.
 * Another addon's own per-device data is cleaned by that addon, off
 * `DeviceUnregistered` — the kernel never reaches into its tables (D864).
 */
function removalSteps(
  pctx: ProviderContext,
  deviceId: number,
  providerAddonId: string,
  deletedAt: number,
): readonly RemovalStep[] {
  const secrets = pctx.host.ctx.secrets
  return [
    {
      // The recorded fact of the deletion (D865). First, so that whatever else
      // fails, an addon that was down still finds the device in
      // `listDeletedSince`. Written by this delete path ONLY — an unregistered
      // or offline device never reaches it.
      store: 'tombstone',
      run: async () => {
        await pctx.tombstones.record({ deviceId, deletedAt, providerAddonId })
        return 1
      },
    },
    {
      // Every owner's `device/<id>` secrets (the driver's connection password,
      // an access code…): D787 keeps each in the keychain under the DRIVER's
      // name, so only a scope-wide delete reaches them all.
      store: 'keychain-secrets',
      run: async () => {
        const purge = secrets?.deleteDeviceScope
        if (purge === undefined) {
          pctx.host.ctx.logger.warn('device secrets not purged — no keychain door', {
            tags: { deviceId },
          })
          return 0
        }
        return (await purge(deviceId)).length
      },
    },
    {
      // Delete all per-device config rows so no orphaned settings remain.
      store: 'device-config',
      run: async () => {
        const stored = await pctx.settings.readDeviceStore(deviceId)
        await pctx.settings.clearDeviceStore(deviceId)
        return Object.keys(stored).length
      },
    },
    {
      // EVERY addon's per-device settings (D865). Per-device configuration has
      // one home, `addon-device-settings` (`ctx.settings.*DeviceStore`), and a
      // device's scope there stops being anybody's when the device goes: no
      // addon needs a hook for it. The step above clears device-manager's own
      // scope; this one clears the rest in one statement, matched on the
      // device id each row carries.
      store: 'addon-device-settings',
      run: async () => {
        const api = pctx.host.ctx.api?.settingsStore
        if (api === undefined) throw new Error('settings-store api not available')
        return clearDeviceSettings(
          { deleteWhere: (input) => api.deleteWhere.mutate(input) },
          deviceId,
        )
      },
    },
    {
      // Forget the device in the runtime-state mirror FIRST: an armed debounce
      // would otherwise fire after the clear below and write the row back from
      // memory, orphaned (D677). Then drop the device's runtime-state slice —
      // otherwise those rows orphan for the lifetime of the DB.
      store: 'runtime-state',
      run: async () => {
        await pctx.host.forgetMirrorDevice(deviceId)
        const stored = await pctx.settings.readDeviceRuntimeState(deviceId)
        await pctx.settings.clearDeviceRuntimeState(deviceId)
        return Object.keys(stored).length
      },
    },
    {
      // Its claims from the index (D663, condition i): the row that carried
      // them is gone, so a listing that still named the device would be a lie.
      store: 'field-claims',
      run: async () => {
        await pctx.host.fieldClaims.pruneDevice(deviceId, pctx.settings)
        return 0
      },
    },
    {
      // Persisted wrapper activations tied to this device, so
      // `getBindings({deviceId})` stops returning stale entries after remove.
      //
      // Under the addon-store lock, not the meta lock: this rewrites the WHOLE
      // fleet-wide `deviceBindings` record to delete one device's slice of it,
      // so unordered it destroys whatever a concurrent `setWrapperActive` on
      // another camera had just written.
      store: 'bindings',
      run: () =>
        pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
          const key = String(deviceId)
          const bindingsStore = await readBindingsStore(pctx.bindingsDeps)
          const slice = bindingsStore.deviceBindings[key]
          if (!slice) return 0
          const { [key]: _removed, ...rest } = bindingsStore.deviceBindings
          await writeBindingsStore(pctx.bindingsDeps, { deviceBindings: rest })
          return Object.keys(slice).length
        }),
    },
    // Last: every implementer of `device-removal-hook` deletes what it keeps
    // for the device (footage, analytics, history, per-addon settings…). Each
    // implementer is retried on its own; one that stays unreachable is caught
    // by its own reconcile from the tombstone above.
    removalHookStep(pctx.removalHooks, { deviceId, deletedAt, providerAddonId }),
  ]
}

export async function removeDevice(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeDevice']>[0],
): ReturnType<IDeviceManagerProvider['removeDevice']> {
  const { deviceId } = input
  // Resolve the row before deleting it: the `DeviceUnregistered` event carries
  // the device's name and `parentDeviceId`, and by the time it fires the row is
  // gone.
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) {
    // Removal of an unknown device is a no-op (idempotent) — the
    // caller may be racing teardown after a crash. No throw: the
    // hub-level `remove()` already error-checks first.
    return
  }
  const { addonId, stableId, meta: persistedMeta } = persisted
  const deviceName = persistedMeta.name

  // Identity, index membership and hardware metadata were three blobs that had
  // to be rewritten in step; they are three columns of one row now, so removal
  // is one DELETE. Still under the write lock so it orders against a concurrent
  // register's read-modify-write of the same row.
  await pctx.metaStore.withMetaWriteLock(async () => {
    await pctx.metaStore.rows.remove(deviceId)
    // Fence the identity BEFORE the lock is released: a `registerDevice` or
    // `allocateDeviceId` queued behind us must find the fence, not an empty
    // slot to re-fill (D376).
    pctx.removalFence.record({ deviceId, addonId, stableId })
  })
  pctx.secretConfigPaths.delete(deviceId)

  // Everything below is data of a device that no longer exists. Each store is
  // its own step (D864): one that throws neither skips the others nor fails the
  // removal — the row is already gone, so the operator could not retry it —
  // and a failed step is retried by a bounded reconcile. One log line per
  // device carries the counts per store.
  await pctx.removalCleanup.run(deviceId, removalSteps(pctx, deviceId, addonId, Date.now()))

  // Drop the push-fed `remoteNativeCaps` cache entry for this device.
  // The HubNodeRegistry (`listClusterNativeCaps`) will be cleaned up
  // automatically when the worker re-handshakes without the device.
  pctx.host.remoteNativeCaps.delete(deviceId)
  // Hub-local natives live in the CapabilityRegistry — clear them too
  // so in-process devices don't linger in `getNativeCapsForDevice`.
  pctx.host.capabilityRegistry?.unregisterAllNativeForDevice(deviceId)

  pctx.metaStore.idToAddonId.delete(deviceId)

  pctx.host.ctx.logger.info('removed device', {
    tags: { deviceId, deviceName: deviceName.length > 0 ? deviceName : stableId },
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceUnregistered,
    data: {
      deviceId,
      providerId: addonId,
      // Carry parentDeviceId so listeners can filter on "is
      // this MY child?" without consulting an in-memory map
      // they had to keep in sync. By the time this event
      // fires the meta row is already gone — we read it from
      // the resolved snapshot above.
      parentDeviceId: persistedMeta.parentDeviceId ?? null,
    },
  })
}

export async function persistConfig(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['persistConfig']>[0],
): ReturnType<IDeviceManagerProvider['persistConfig']> {
  const { deviceId, data } = input
  // Per-device config is keyed by numeric id end-to-end. We still
  // verify the device is known (resolves through meta) so a write
  // for a non-existent id throws instead of silently allocating a
  // stray store entry.
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) throw new Error(`[device-manager] persistConfig: unknown device id=${deviceId}`)
  // The keychain door (D787): the declared secret paths are stored for the
  // DRIVER, never in this blob.
  await persistDeviceConfigWithSecrets(
    {
      ctx: pctx.host.ctx,
      readStored: () => pctx.settings.readDeviceStore(deviceId),
      write: (patch) => pctx.settings.writeDeviceStore(deviceId, patch),
    },
    {
      deviceId,
      ownerAddonId: persisted.addonId,
      data,
      secretPaths: input.secretConfigPaths ?? pctx.secretConfigPaths.get(deviceId) ?? [],
      // A driver's write arrives stamped with its id; an unstamped one is the
      // operator's (an admin API call), which is stored as sent (D787).
      operatorWrite: typeof Reflect.get(input, 'callerAddonId') !== 'string',
    },
  )
}

export async function loadConfig(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['loadConfig']>[0],
): ReturnType<IDeviceManagerProvider['loadConfig']> {
  const { deviceId } = input
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) return {}
  // Resolved at the door, for the driver that owns the row — no driver ever
  // sees a keychain marker (D787).
  return loadDeviceConfigWithSecrets(pctx.host.ctx, {
    deviceId,
    ownerAddonId: persisted.addonId,
    stored: await pctx.settings.readDeviceStore(deviceId),
  })
}

/**
 * Load the operator-organisational meta surface for one device
 * (`name` / `location` / `disabled` / `type` / `parentDeviceId`
 * / `addonId` + `id` / `stableId`). Used by the kernel proxy's
 * device-context factory to populate `ctx.deviceMeta` before
 * the device class constructor runs. Returns `null` when no
 * persisted row exists for the id.
 *
 * Reads default `location` to `null` and `disabled` to `false`
 * for legacy rows that predate the field — production code
 * relies on the IDevice type contract that both are present.
 */
export async function loadMeta(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['loadMeta']>[0],
): ReturnType<IDeviceManagerProvider['loadMeta']> {
  const { deviceId } = input
  const row = await pctx.metaStore.getRow(deviceId)
  if (row === null) return null
  const { meta: m, metadata } = row
  const { addonId, stableId } = m
  return {
    id: m.id,
    stableId,
    addonId,
    type: m.type as DeviceType,
    name: m.name,
    location: m.location ?? null,
    disabled: m.disabled ?? false,
    parentDeviceId: m.parentDeviceId,
    metadata,
    ...(m.integrationId !== undefined ? { integrationId: m.integrationId } : {}),
    ...(m.linkDeviceId !== undefined ? { linkDeviceId: m.linkDeviceId } : {}),
    ...(m.role !== undefined ? { role: m.role } : {}),
  }
}

/**
 * Update the operator-edited display name. Writes the meta
 * row, emits a `DeviceMetaChanged` event so live consumers
 * (UI device list, alert center) see the rename without
 * polling. The live `IDevice.name` mirror is updated by the
 * kernel proxy on its side (`device-cap-proxy.ts`).
 */
export async function setName(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setName']>[0],
): ReturnType<IDeviceManagerProvider['setName']> {
  const { deviceId, name } = input
  // Child ids whose name was cascaded from the parent rename (emitted below).
  const cascaded: Array<{ id: number; name: string }> = []
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setName: unknown device id=${deviceId}`)
    const { meta: m } = persisted
    const oldName = m.name
    // Mark the row user-named (#17) so the reconcile preserves this name
    // against a provider's fresh construction-time name on re-register.
    await pctx.metaStore.rows.patch(deviceId, { name, userNamed: true })

    // Cascade the rename to accessory/linked children whose display name was
    // DERIVED from the parent's name (e.g. a Gree AC child named exactly like
    // its container, or "<container> Light"). Only children that (a) link to
    // THIS device (parentDeviceId or linkDeviceId), (b) were NOT independently
    // renamed by the operator (`userNamed`), and (c) still carry the old parent
    // name as a prefix are updated — a prefix replace so "<old> Light" becomes
    // "<new> Light" and an exact match becomes the new name.
    //
    // We deliberately do NOT gate on `userNamed`: accessory children get
    // auto-named from the parent (e.g. the Gree AC child == the container name)
    // but the register reconcile stamps them `userNamed` because their name !=
    // stableId — so a userNamed check would skip exactly the children we must
    // cascade. Matching the derived-name PATTERN (== oldName, or "oldName
    // <suffix>") is itself the safeguard: an operator's independent custom name
    // won't carry the parent's old name as a prefix, so it is left untouched.
    //
    // The candidate set is the device's own children plus anything that LINKS
    // to it. `parentDeviceId` is indexed; `linkDeviceId` is not a parent
    // relation, so those are found by scanning the fleet — the one place this
    // module still reads every row, and it runs only on an operator rename.
    if (oldName.length > 0 && oldName !== name) {
      const candidates = new Map<number, PersistedDeviceMeta>()
      for (const row of await pctx.metaStore.rows.listByParent(deviceId)) {
        candidates.set(row.meta.id, row.meta)
      }
      for (const row of await pctx.metaStore.rows.listAll()) {
        if (row.meta.linkDeviceId === deviceId) candidates.set(row.meta.id, row.meta)
      }
      candidates.delete(deviceId)
      for (const childMeta of candidates.values()) {
        if (childMeta.name !== oldName && !childMeta.name.startsWith(`${oldName} `)) continue
        const childName =
          childMeta.name === oldName ? name : `${name}${childMeta.name.slice(oldName.length)}`
        await pctx.metaStore.rows.patch(childMeta.id, { name: childName })
        cascaded.push({ id: childMeta.id, name: childName })
      }
    }
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'name', value: name },
  })
  for (const child of cascaded) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: child.id },
      category: EventCategory.DeviceMetaChanged,
      data: { deviceId: child.id, field: 'name', value: child.name },
    })
  }
}

/**
 * Every descendant of `rootId`, walked via `parentDeviceId` chains.
 *
 * BFS one LEVEL per query, not one node per query: `listByParentMany` asks for
 * the whole frontier's children in a single indexed `whereIn`, so a tree costs
 * as many reads as it is DEEP, never as many as it has nodes. It used to be
 * `listByParent` per node — the same N+1 the boot census measured at 1 024
 * calls on `getChildren`.
 *
 * `visited` seeded with `rootId` guards a pathological parent-cycle in
 * persisted data from recursing forever; a row already seen is never re-queued
 * or re-emitted. Depth is unbounded on purpose — a nested container's own
 * children are still `rootId`'s descendants and must align too.
 */
async function collectDescendants(
  metaStore: DeviceMetaStore,
  rootId: number,
): Promise<PersistedDeviceMeta[]> {
  const out: PersistedDeviceMeta[] = []
  const visited = new Set<number>([rootId])
  let frontier: number[] = [rootId]
  while (frontier.length > 0) {
    const byParent = await metaStore.rows.listByParentMany(frontier)
    const next: number[] = []
    for (const parentId of frontier) {
      for (const row of byParent.get(parentId) ?? []) {
        if (visited.has(row.meta.id)) continue
        visited.add(row.meta.id)
        out.push(row.meta)
        next.push(row.meta.id)
      }
    }
    frontier = next
  }
  return out
}

/**
 * Update the operator-organisational location label. `null`
 * clears it. Mirrors the same persist-then-emit shape as
 * `setName`; consumers subscribe to `DeviceMetaChanged` and
 * filter on `field: 'location'`.
 *
 * CASCADE (operator decision, 2026-08-26; widened to EVERY parent 2026-09-01):
 * supersedes the read-time inheritance `device-linked-devices.ts` used to
 * resolve. The SAME location is written to every descendant's own `location`
 * column, recursively, in this exact call — never resolved live by a reader
 * again. This DELIBERATELY overwrites a descendant's own, possibly different,
 * location: a cascade is a write, and a write that stops at an existing value
 * is not a cascade — the operator setting the parent's location is understood
 * as organising the whole subtree by it.
 *
 * NO TYPE PREDICATE. The cascade used to fire only for `DeviceType.Container`,
 * which split the fleet by an accident of provider modelling: on the measured
 * hub, 50 containers cascaded to 440 children while 13 non-container parents
 * (11 `camera`, 2 `hub`) left 20 accessories behind. The Locations page tells
 * the operator "assign the parent, the accessories follow"; a predicate here
 * would make that a lie for exactly the cameras. `collectDescendants` is
 * type-agnostic, and so is this.
 *
 * RETROACTIVITY: this only runs when `setLocation` is called. A parent that
 * already had a location before this shipped does NOT retroactively align its
 * descendants — they stay unaligned until the operator re-saves the parent's
 * location.
 *
 * ATOMICITY: the whole cascade runs inside ONE `withMetaWriteLock` critical
 * section, so no concurrent writer can interleave a read or a write into the
 * middle of it — but it is still N separate row writes, not one transaction.
 * A row write that throws does NOT abort the cascade (a swallowed continue,
 * not a silent one): it is collected as a failure, every other descendant is
 * still attempted, and if any failed the outcome is logged at `error` with
 * every failing id — never indistinguishable from a clean cascade. A
 * `DeviceMetaChanged` event fires for the parent itself and for every
 * descendant actually written (never for one that failed), so linked-device
 * consumers (the linked-devices picker, which suggests by location) see exactly what landed.
 */
export async function setLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocation']>[0],
): ReturnType<IDeviceManagerProvider['setLocation']> {
  const { deviceId, location } = input
  const cascaded: number[] = []
  const failed: Array<{ id: number; error: unknown }> = []
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setLocation: unknown device id=${deviceId}`)
    await pctx.metaStore.rows.patch(deviceId, { location })

    const descendants = await collectDescendants(pctx.metaStore, deviceId)
    for (const descendant of descendants) {
      try {
        await pctx.metaStore.rows.patch(descendant.id, { location })
        cascaded.push(descendant.id)
      } catch (err) {
        failed.push({ id: descendant.id, error: err })
      }
    }
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'location', value: location },
  })
  for (const childId of cascaded) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: childId },
      category: EventCategory.DeviceMetaChanged,
      data: { deviceId: childId, field: 'location', value: location },
    })
  }
  if (cascaded.length > 0 || failed.length > 0) {
    pctx.host.ctx.logger.info('setLocation: cascaded location to descendants', {
      tags: { deviceId },
      meta: { location, updated: cascaded.length, failed: failed.length },
    })
  }
  if (failed.length > 0) {
    pctx.host.ctx.logger.error(
      'setLocation: cascade partially failed — some descendants NOT aligned to the new location',
      {
        tags: { deviceId },
        meta: {
          location,
          failedIds: failed.map((f) => f.id),
          errors: failed.map((f) => (f.error instanceof Error ? f.error.message : String(f.error))),
        },
      },
    )
  }
}

/**
 * Update the device type. Writes the meta row, emits a
 * `DeviceMetaChanged` event. Used by the kernel to apply
 * `initialMeta.type` before device construction so the device
 * constructs with its real type instead of the `allocateDeviceId`
 * placeholder `'generic'`.
 */
export async function setType(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setType']>[0],
): ReturnType<IDeviceManagerProvider['setType']> {
  const { deviceId, type } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setType: unknown device id=${deviceId}`)
    await pctx.metaStore.rows.patch(deviceId, { type })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'type', value: type },
  })
}

/**
 * Stamp (or update) the owning integration id on the device's
 * meta row. Called by the kernel's `create()` pre-seed path
 * when `initialMeta.integrationId` is set (analogous to
 * `setName` / `setType`). Idempotent.
 */
export async function setIntegrationId(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setIntegrationId']>[0],
): ReturnType<IDeviceManagerProvider['setIntegrationId']> {
  await pctx.stampIntegrationId(input.deviceId, input.integrationId)
}

/**
 * Stamp (or update) the linked device id on the device's meta
 * row. Called by the kernel's `create()` pre-seed path when
 * `initialMeta.linkDeviceId` is set (analogous to `setIntegrationId`).
 * Idempotent. `null` explicitly clears a previous link.
 */
export async function setLinkDeviceId(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLinkDeviceId']>[0],
): ReturnType<IDeviceManagerProvider['setLinkDeviceId']> {
  const { deviceId, linkDeviceId } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted)
      throw new Error(`[device-manager] setLinkDeviceId: unknown device id=${deviceId}`)
    await pctx.metaStore.rows.patch(deviceId, { linkDeviceId })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'linkDeviceId', value: linkDeviceId },
  })
}

/**
 * Set (or clear) the durable primary-child override on a CONTAINER
 * device's meta row, keyed on the chosen child's re-sync/rename-stable
 * `entityId`. Mirrors `setLinkDeviceId` but persists a string entityId
 * (survives a re-sync that reallocates the child's numeric id) instead
 * of the numeric child id. `null` clears the override → priority default.
 */
export async function setPrimaryChildEntityId(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setPrimaryChildEntityId']>[0],
): ReturnType<IDeviceManagerProvider['setPrimaryChildEntityId']> {
  const { deviceId, primaryChildEntityId } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted)
      throw new Error(`[device-manager] setPrimaryChildEntityId: unknown device id=${deviceId}`)
    // A pick that matches NO child is stored (a re-sync may add the child
    // later) but must never pass silently: `resolveContainerPrimaryChild`
    // falls through to the priority default, so the container keeps the value
    // the operator just rejected while the mutation answered success. That is
    // how the same pick got made twice on container 4127 with nothing to show
    // for it — the write was keyed on `sourceInfo.id` and the resolver matches
    // `stableId`.
    if (primaryChildEntityId !== null) {
      const children = await pctx.metaStore.rows.listByParent(deviceId)
      const matched = children.some((child) => child.meta.stableId === primaryChildEntityId)
      if (!matched) {
        pctx.host.ctx.logger.warn(
          'setPrimaryChildEntityId: pick matches no child — the container will keep its priority default',
          {
            tags: { deviceId },
            meta: {
              primaryChildEntityId,
              childStableIds: children.map((child) => child.meta.stableId).slice(0, 12),
            },
          },
        )
      }
    }
    await pctx.metaStore.rows.patch(deviceId, { primaryChildEntityId })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'primaryChildEntityId', value: primaryChildEntityId },
  })
}

/**
 * Set (or replace) the container-level `childLayout` on a device's
 * meta row. Mirrors `setPrimaryChildEntityId` but persists the
 * accordion-section layout array (parent-only). Persisted, projected,
 * and preserved across re-register/restore.
 */
export async function setChildLayout(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setChildLayout']>[0],
): ReturnType<IDeviceManagerProvider['setChildLayout']> {
  const { deviceId, childLayout } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted)
      throw new Error(`[device-manager] setChildLayout: unknown device id=${deviceId}`)
    await pctx.metaStore.rows.patch(deviceId, { childLayout })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'childLayout', value: childLayout },
  })
}

/**
 * Stamp (or update) the semantic role on the device's meta row.
 * Called by the kernel's `create()` / `spawnAccessoryChild`
 * pre-seed when `initialMeta.role` is set (analogous to
 * `setIntegrationId`). Idempotent. `null` clears a previous role.
 */
export async function setRole(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setRole']>[0],
): ReturnType<IDeviceManagerProvider['setRole']> {
  const { deviceId, role } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setRole: unknown device id=${deviceId}`)
    await pctx.metaStore.rows.patch(deviceId, { role })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'role', value: role },
  })
}

/**
 * Normalize an operator-authored display override at write time so the render
 * path's `UNIT_TABLE` lookups always hit canonical spellings — maps `unit` and
 * every `perCap[*].unit` through `normalizeUnit`. Pure: rebuilds new objects,
 * never mutates the input. A unit `normalizeUnit` cannot canonicalize is left
 * as-is (the render path refuses conversion for unknown spellings).
 */
function normalizeDisplayOverride(display: DeviceDisplayOverride): DeviceDisplayOverride {
  const next: DeviceDisplayOverride = {
    ...display,
    ...(display.unit !== undefined ? { unit: normalizeUnit(display.unit) ?? display.unit } : {}),
    ...(display.perCap !== undefined
      ? {
          perCap: Object.fromEntries(
            Object.entries(display.perCap).map(
              ([cap, refine]): [string, DeviceCapDisplayOverride] => [
                cap,
                refine.unit !== undefined
                  ? { ...refine, unit: normalizeUnit(refine.unit) ?? refine.unit }
                  : refine,
              ],
            ),
          ),
        }
      : {}),
  }
  return next
}

/**
 * Set (or clear) the per-device display override on a device's meta row.
 * Mirrors `setChildLayout` persistence; `null` REMOVES the `display` key
 * entirely (immutable rest-destructure — matches the "absent ⇒ no override"
 * projection contract, never persists `display: undefined`). Override units are
 * normalized at write so the render path always looks up canonical spellings.
 */
export async function setDisplay(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setDisplay']>[0],
): ReturnType<IDeviceManagerProvider['setDisplay']> {
  const { deviceId, display } = input
  const normalized = display === null ? null : normalizeDisplayOverride(display)
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setDisplay: unknown device id=${deviceId}`)
    // `null` CLEARS the column, which is the same thing the blob shape spelled
    // as "remove the key": both read back as "absent ⇒ no override".
    await pctx.metaStore.rows.patch(deviceId, { display: normalized })
  })
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'display', value: normalized },
  })
}

/**
 * Read the operator-authored per-role display defaults. Empty record when none
 * set. Not per-device — a plain top-level-key read.
 */
export async function getRoleDisplayDefaults(
  pctx: ProviderContext,
  _input: Parameters<IDeviceManagerProvider['getRoleDisplayDefaults']>[0],
): ReturnType<IDeviceManagerProvider['getRoleDisplayDefaults']> {
  const store = await pctx.metaStore.readStore()
  return { defaults: store.roleDisplayDefaults ?? {} }
}

/**
 * Replace the per-role display defaults whole-record (full replace). Override
 * units are normalized (`normalizeUnit`) at write so the render path always
 * looks up canonical spellings. Not per-device, so no event is emitted; the UI
 * invalidates its own query on mutate.
 *
 * This key is not itself read-modify-written, but `writeAddonStore` IS — the
 * door loads this addon's whole key range, merges the patch and re-inserts the
 * range (`settings-door-view.ts`). An unordered write of ANY key on that range
 * can therefore carry a stale copy of every other key, so it takes the same
 * lock as `deviceBindings` and `locations`. The old comment here claimed "no
 * lock, no RMW", which described the top-level key and not the write.
 */
export async function setRoleDisplayDefaults(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setRoleDisplayDefaults']>[0],
): ReturnType<IDeviceManagerProvider['setRoleDisplayDefaults']> {
  const normalized: Record<string, RoleDisplayDefault> = Object.fromEntries(
    Object.entries(input.defaults).map(([role, def]): [string, RoleDisplayDefault] => [
      role,
      def.unit !== undefined ? { ...def, unit: normalizeUnit(def.unit) ?? def.unit } : def,
    ]),
  )
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    await pctx.settings.writeAddonStore({ roleDisplayDefaults: normalized })
  })
}

/**
 * Batched meta pre-seed. Applies every provided field to the
 * device's meta row in ONE read-modify-write under a single
 * `withMetaWriteLock` acquisition (one row write),
 * then emits one `DeviceMetaChanged` event per field that was
 * supplied — preserving the exact semantics of the individual
 * setters (`setName` / `setLocation` / `setType` /
 * `setIntegrationId` / `setLinkDeviceId` / `setRole`). Omitted
 * fields are left untouched; `null` clears `location` /
 * `linkDeviceId` / `role`. Idempotent.
 *
 * Collapses the per-child meta pre-seed (up to 6 individual
 * setter round-trips, each its own lock + write) into one — the
 * dominant cost when the kernel's `spawnAccessoryChild` reconciles
 * a many-entity container.
 */
export async function applyInitialMeta(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['applyInitialMeta']>[0],
): ReturnType<IDeviceManagerProvider['applyInitialMeta']> {
  const { deviceId, name, location, type, integrationId, linkDeviceId, role } = input
  await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted)
      throw new Error(`[device-manager] applyInitialMeta: unknown device id=${deviceId}`)
    // ONE row write naming only the columns the caller supplied — an omitted
    // field is not in the `SET` list, so it keeps its persisted value (mirrors
    // the per-field setters' single-field merge).
    await pctx.metaStore.rows.patch(deviceId, {
      ...(name !== undefined ? { name } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(integrationId !== undefined ? { integrationId } : {}),
      ...(linkDeviceId !== undefined ? { linkDeviceId } : {}),
      ...(role !== undefined ? { role } : {}),
    })
  })
  // Emit one DeviceMetaChanged per supplied field — same event shape
  // and field names the individual setters emit, so existing
  // subscribers react identically.
  const emitMetaChanged = (field: string, value: unknown): void => {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: deviceId },
      category: EventCategory.DeviceMetaChanged,
      data: { deviceId, field, value },
    })
  }
  if (name !== undefined) emitMetaChanged('name', name)
  if (location !== undefined) emitMetaChanged('location', location)
  if (type !== undefined) emitMetaChanged('type', type)
  if (integrationId !== undefined) emitMetaChanged('integrationId', integrationId)
  if (linkDeviceId !== undefined) emitMetaChanged('linkDeviceId', linkDeviceId)
  if (role !== undefined) emitMetaChanged('role', role)
}

/**
 * Patch the device's hardware-identity metadata blob. Shallow
 * merge — `null` removes a key, anything else overwrites.
 * Drivers populate factual fields on first probe; operators
 * augment via the Device Info tab. Idempotent: a no-op patch
 * (every key already present with the same value) doesn't emit
 * the meta-changed event.
 */
export async function setMetadata(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setMetadata']>[0],
): ReturnType<IDeviceManagerProvider['setMetadata']> {
  const { deviceId, patch } = input
  const result = await pctx.metaStore.withMetaWriteLock(async () => {
    const row = await pctx.metaStore.rows.get(deviceId)
    if (row === null) throw new Error(`[device-manager] setMetadata: unknown device id=${deviceId}`)
    const current = row.metadata ?? {}
    const next: Record<string, unknown> = { ...current }
    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        if (k in next) {
          delete next[k]
          changed = true
        }
      } else if (next[k] !== v) {
        next[k] = v
        changed = true
      }
    }
    if (!changed) return { changed: false as const }
    const hasFields = Object.keys(next).length > 0
    // An emptied blob is stored as NULL, not as `{}` — the blob shape deleted
    // the map entry for the same reason, and every reader treats both as
    // "this device has no metadata".
    await pctx.metaStore.rows.patch(deviceId, { metadata: hasFields ? next : null })
    return { changed: true as const, finalMeta: hasFields ? next : null }
  })
  if (!result.changed) return
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'metadata', value: result.finalMeta },
  })
}

/**
 * Soft-disable the device. Persisted on the meta row;
 * lifecycle gating is the driver's responsibility (BaseDevice
 * exposes `this.disabled` for the driver to consult at the top
 * of its lifecycle methods).
 *
 * TWO events leave here, and they are not the same message:
 *
 *  - `device.meta-changed` fires on EVERY call. It is the meta-surface echo
 *    every UI redraws on, and idempotence is not interesting to it.
 *  - `device.disabled` / `device.enabled` fire ONLY when the flag actually
 *    MOVES. They are the lifecycle announcement — the operator asked to be
 *    told when a camera is switched off, and a write that re-states a flag the
 *    device already had is not that. Telemetry semantics (D8) are fine here: a
 *    dropped announcement costs a notification, never durable state, and the
 *    meta row is the authority either way (D62 — this switch stores nothing of
 *    its own).
 */
/** What one `disabled` write found and did — feeds the transition-gated events. */
interface DisabledFlagWrite {
  readonly changed: boolean
  readonly integrationId: string
}

/**
 * Read + patch the `disabled` flag. The caller HOLDS the meta write lock —
 * this is split out of {@link setDisabled} so `migrateDevice`, which holds the
 * lock for its whole run, can write the same authority without re-acquiring
 * it (the self-deadlock documented at its `setSwitch`).
 */
async function writeDisabledFlagUnderLock(
  pctx: ProviderContext,
  deviceId: number,
  disabled: boolean,
): Promise<DisabledFlagWrite> {
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) throw new Error(`[device-manager] setDisabled: unknown device id=${deviceId}`)
  const { meta: m } = persisted
  await pctx.metaStore.rows.patch(deviceId, { disabled })
  // A legacy row without the flag is an ENABLED device — that is what every
  // reader of `meta.disabled` already assumes.
  return {
    changed: (m.disabled ?? false) !== disabled,
    integrationId: m.integrationId ?? '',
  }
}

/** The two announcements — meta echo always, lifecycle only on a transition. */
function emitDisabledEvents(
  pctx: ProviderContext,
  deviceId: number,
  disabled: boolean,
  moved: DisabledFlagWrite,
): void {
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'disabled', value: disabled },
  })
  if (!moved.changed) return
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: disabled ? EventCategory.DeviceDisabled : EventCategory.DeviceEnabled,
    data: { deviceId, integrationId: moved.integrationId },
  })
}

export async function setDisabled(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setDisabled']>[0],
): ReturnType<IDeviceManagerProvider['setDisabled']> {
  const { deviceId, disabled } = input
  // The previous value is read INSIDE the write lock — read it outside and two
  // concurrent flips can both look like transitions.
  const moved = await pctx.metaStore.withMetaWriteLock(() =>
    writeDisabledFlagUnderLock(pctx, deviceId, disabled),
  )
  emitDisabledEvents(pctx, deviceId, disabled, moved)
}

export async function loadRuntimeState(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['loadRuntimeState']>[0],
): ReturnType<IDeviceManagerProvider['loadRuntimeState']> {
  const { deviceId } = input
  const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
  if (!persisted) return {}
  const data = await pctx.settings.readDeviceRuntimeState(deviceId)
  // Seed the mirror at first load so the hub knows about every
  // existing slice immediately — providers might never call
  // `setCapSlice` if their runtime state doesn't change, and
  // the mirror would otherwise stay empty until the first
  // change. The `feature-probe` slice's `lastProbedAt` is reset to 0
  // for the mirror (see `withResetSessionProbe`) so a stale pre-restart
  // probe doesn't masquerade as a completed THIS-SESSION probe and
  // trigger a spurious export re-advertise. The returned `data` (the
  // worker's `initialRuntimeState`) is untouched — except that the claims
  // record (`$owned`, D663) stays on the hub: the provider hydrates exactly
  // its own truth and never learns which of its fields a composition owns.
  pctx.host.seedMirror(deviceId, pctx.host.withResetSessionProbe(data))
  return splitRuntimeBlob(data).native
}

/**
 * Union of (1) operator-curated location registry and (2) labels
 * currently in use on persisted devices. Case-insensitive
 * dedupe (preserves the first-seen casing). Sorted
 * case-insensitively for stable UI. Drives the Device Info
 * location autocomplete.
 */
export async function listLocations(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocations']> {
  const store = await pctx.metaStore.readStore()
  const locations = store.locations ?? []
  // Map from lower-cased key to the first-seen casing so duplicate
  // entries with different cases collapse to one.
  const seen = new Map<string, string>()
  const consider = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    const key = trimmed.toLowerCase()
    if (!seen.has(key)) seen.set(key, trimmed)
  }
  for (const label of locations) consider(label)
  for (const row of await pctx.metaStore.rows.listAll()) consider(row.meta.location)
  return [...seen.values()].toSorted((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Add a label to the curated location registry. Idempotent:
 * existing entries (case-insensitive match) are silently kept.
 * Empty / whitespace-only inputs throw — operators must supply a
 * meaningful label.
 */
export async function addLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['addLocation']>[0],
): ReturnType<IDeviceManagerProvider['addLocation']> {
  const trimmed = input.name.trim()
  if (trimmed.length === 0) {
    throw userError(
      'system.location-name-required',
      undefined,
      '[device-manager] addLocation: name must be non-empty',
    )
  }
  // Read-modify-write of the `locations` ARRAY: two operators adding two
  // labels at once each appended to their own pre-read copy, and the second
  // write replaced the first. Same shape as `deviceBindings`, same lock.
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const current = store.locations ?? []
    if (current.some((l) => l.toLowerCase() === trimmed.toLowerCase())) {
      // Already present — no-op (preserves first-seen casing).
      return
    }
    await pctx.settings.writeAddonStore({ locations: [...current, trimmed] })
  })
}

/**
 * Every location that carries an icon, as `(locationKey, icon)` pairs.
 *
 * ADDITIVE beside `listLocations`, which still answers `string[]` — the
 * autocomplete, the HA adoption import and the recorder all read a list of
 * LABELS and a shape change there would break every one of them. A surface
 * that wants icons asks for them and joins on `locationIconKey`.
 *
 * Returns only what was actually stored. A location with no assignment is
 * ABSENT, never `map-pin`: the fallback belongs to the renderer
 * (`resolveIconKey`), and folding it in here would make "the operator
 * picked the pin" indistinguishable from "the operator picked nothing" —
 * which is the difference an icon picker has to draw.
 */
export async function listLocationIcons(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocationIcons']> {
  const store = await pctx.metaStore.readStore()
  const icons = store.locationIcons ?? {}
  return Object.entries(icons)
    .map(([locationKey, icon]) => ({ locationKey, icon }))
    .toSorted((a, b) => a.locationKey.localeCompare(b.locationKey))
}

/**
 * Set (or clear) the icon of a location label.
 *
 * Keyed on `locationIconKey` — trimmed + lower-cased, the equality the
 * registry matches on everywhere — so a case-only rename keeps the icon and
 * two spellings of one room can never carry two different icons.
 *
 * The label need NOT be registered: `setLocation` accepts a free-form string
 * and `listLocations` folds in whatever devices carry, so requiring
 * registration here would leave exactly the ad-hoc rooms unable to have an
 * icon. An empty label throws — there is no room to name.
 *
 * Same read-modify-write and same lock as `addLocation`: the map is one key of
 * the addon store, and `writeAddonStore` re-inserts the whole key range, so an
 * unordered write carries a stale copy of every other key.
 */
export async function setLocationIcon(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationIcon']>[0],
): ReturnType<IDeviceManagerProvider['setLocationIcon']> {
  const trimmed = input.location.trim()
  if (trimmed.length === 0) {
    throw userError(
      'system.location-required',
      undefined,
      '[device-manager] setLocationIcon: location must be non-empty',
    )
  }
  const key = locationIconKey(trimmed)
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const icons = store.locationIcons ?? {}
    if (input.icon === null) {
      if (!(key in icons)) return
      const { [key]: _cleared, ...kept } = icons
      await pctx.settings.writeAddonStore({ locationIcons: kept })
      return
    }
    if (icons[key] === input.icon) return
    await pctx.settings.writeAddonStore({
      locationIcons: { ...icons, [key]: input.icon },
    })
  })
}

/**
 * Every location that carries a description, sorted by key.
 *
 * Only what was WRITTEN — a location with no description is absent, and the
 * digest then tells the model the location name alone, exactly as it did
 * before descriptions existed.
 */
export async function listLocationDescriptions(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocationDescriptions']> {
  const store = await pctx.metaStore.readStore()
  const descriptions = store.locationDescriptions ?? {}
  return Object.entries(descriptions)
    .map(([locationKey, description]) => ({ locationKey, description }))
    .toSorted((a, b) => a.locationKey.localeCompare(b.locationKey))
}

/**
 * Set (or clear) a location's description.
 *
 * A BLANK description clears, exactly as `null` does: an empty line handed to
 * a vision model costs attention and says nothing, so the two must not be
 * different states. The label is folded with `locationIconKey` — the same key
 * the icon uses, which is the whole point of this living here.
 *
 * Same read-modify-write and same lock as `setLocationIcon`; `writeAddonStore`
 * re-inserts the whole key range, so an unordered write carries a stale copy
 * of every other key.
 */
export async function setLocationDescription(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationDescription']>[0],
): ReturnType<IDeviceManagerProvider['setLocationDescription']> {
  const trimmed = input.location.trim()
  if (trimmed.length === 0) {
    throw new Error('[device-manager] setLocationDescription: location must be non-empty')
  }
  const key = locationIconKey(trimmed)
  const text = input.description === null ? '' : input.description.trim()
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const descriptions = store.locationDescriptions ?? {}
    if (text.length === 0) {
      if (!(key in descriptions)) return
      const { [key]: _cleared, ...kept } = descriptions
      await pctx.settings.writeAddonStore({ locationDescriptions: kept })
      return
    }
    if (descriptions[key] === text) return
    await pctx.settings.writeAddonStore({
      locationDescriptions: { ...descriptions, [key]: text },
    })
  })
}

/**
 * Every site zone, with its rooms, sorted by key.
 *
 * Membership is inverted HERE rather than stored both ways: the store keeps
 * `location → zone`, which is what makes "one zone per room" structural, and a
 * second copy keyed the other way is a second thing that can disagree with the
 * first.
 */
export async function listSiteZones(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listSiteZones']> {
  const store = await pctx.metaStore.readStore()
  const zones = store.siteZones ?? {}
  const membership = store.locationZones ?? {}
  const rooms = new Map<string, string[]>()
  for (const [locationKey, zoneKey] of Object.entries(membership)) {
    const list = rooms.get(zoneKey)
    if (list === undefined) rooms.set(zoneKey, [locationKey])
    else list.push(locationKey)
  }
  return Object.entries(zones)
    .map(([zoneKey, record]) => ({
      zoneKey,
      label: record.label,
      icon: record.icon ?? null,
      locationKeys: (rooms.get(zoneKey) ?? []).toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.zoneKey.localeCompare(b.zoneKey))
}

/**
 * Create a zone, or set the icon of one that already exists.
 *
 * `icon: null` clears the icon and KEEPS the zone. Conflating the two would
 * make a mis-click on "no icon" delete every room's membership — the icon is a
 * decoration and the grouping is the data.
 *
 * `icon` OMITTED leaves whatever icon is there: creating a zone from a screen
 * with no picker must not silently clear the glyph a previous screen set.
 */
export async function setSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['setSiteZone']> {
  const label = input.name.trim()
  if (label.length === 0) {
    throw userError(
      'system.site-zone-name-required',
      undefined,
      '[device-manager] setSiteZone: name must be non-empty',
    )
  }
  const key = siteZoneKey(label)
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const zones = store.siteZones ?? {}
    const existing = zones[key]
    const icon =
      input.icon === undefined ? existing?.icon : input.icon === null ? undefined : input.icon
    const next: SiteZoneRecord = icon === undefined ? { label } : { label, icon }
    if (existing?.label === next.label && existing.icon === next.icon) return
    await pctx.settings.writeAddonStore({ siteZones: { ...zones, [key]: next } })
  })
}

/**
 * Delete a zone. Its LOCATIONS survive, unattached.
 *
 * Deleting a grouping must never delete what was grouped — the rooms exist
 * independently and the devices in them were never touched to begin with.
 */
export async function removeSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['removeSiteZone']> {
  const key = siteZoneKey(input.name)
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const zones = store.siteZones ?? {}
    const membership = store.locationZones ?? {}
    const hadZone = key in zones
    const orphaned = Object.entries(membership).filter(([, zoneKey]) => zoneKey === key)
    if (!hadZone && orphaned.length === 0) return
    const { [key]: _dropped, ...keptZones } = zones
    const keptMembership = Object.fromEntries(
      Object.entries(membership).filter(([, zoneKey]) => zoneKey !== key),
    )
    await pctx.settings.writeAddonStore({
      ...(hadZone ? { siteZones: keptZones } : {}),
      ...(orphaned.length > 0 ? { locationZones: keptMembership } : {}),
    })
  })
}

/**
 * Rename a zone, carrying its icon AND every room in it.
 *
 * It exists so that renaming is not delete-then-recreate, which drops both.
 * A rename onto an existing zone MERGES: the target keeps its own icon and the
 * rooms are unioned, the same rule `renameLocation` follows.
 */
export async function renameSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['renameSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['renameSiteZone']> {
  const toLabel = input.to.trim()
  if (toLabel.length === 0) {
    throw new Error('[device-manager] renameSiteZone: target name must be non-empty')
  }
  const fromKey = siteZoneKey(input.from)
  const toKey = siteZoneKey(toLabel)
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const zones = store.siteZones ?? {}
    const moved = zones[fromKey]
    if (moved === undefined) return
    const { [fromKey]: _dropped, ...rest } = zones
    // A merge keeps the TARGET's record; a plain rename carries the source's
    // icon under the new label.
    const target = rest[toKey]
    const nextZones: Record<string, SiteZoneRecord> = {
      ...rest,
      [toKey]:
        target ??
        (moved.icon === undefined ? { label: toLabel } : { label: toLabel, icon: moved.icon }),
    }
    const membership = store.locationZones ?? {}
    const nextMembership = Object.fromEntries(
      Object.entries(membership).map(([locationKey, zoneKey]) => [
        locationKey,
        zoneKey === fromKey ? toKey : zoneKey,
      ]),
    )
    await pctx.settings.writeAddonStore({
      siteZones: nextZones,
      locationZones: nextMembership,
    })
  })
}

/**
 * Put a location in a zone, or take it out with `zone: null`.
 *
 * ONE slot per location, so a second call moves the room rather than listing it
 * twice. The zone is created if it does not exist — a screen that assigns
 * before creating is a normal order, and refusing it would be the only place in
 * this registry that demands registration first.
 */
export async function setLocationZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationZone']>[0],
): ReturnType<IDeviceManagerProvider['setLocationZone']> {
  const location = input.location.trim()
  if (location.length === 0) {
    throw new Error('[device-manager] setLocationZone: location must be non-empty')
  }
  const locationKey = locationIconKey(location)
  const label = input.zone === null ? null : input.zone.trim()
  if (label !== null && label.length === 0) {
    throw new Error('[device-manager] setLocationZone: zone must be non-empty or null')
  }
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const membership = store.locationZones ?? {}
    if (label === null) {
      if (!(locationKey in membership)) return
      const { [locationKey]: _cleared, ...kept } = membership
      await pctx.settings.writeAddonStore({ locationZones: kept })
      return
    }
    const zoneKey = siteZoneKey(label)
    const zones = store.siteZones ?? {}
    const needsZone = !(zoneKey in zones)
    if (membership[locationKey] === zoneKey && !needsZone) return
    await pctx.settings.writeAddonStore({
      ...(needsZone ? { siteZones: { ...zones, [zoneKey]: { label } } } : {}),
      locationZones: { ...membership, [locationKey]: zoneKey },
    })
  })
}

/**
 * Move a location's zone membership from one key to another, for
 * `renameLocation`. Same shape as the icon and description movers.
 */
function renameLocationZone(
  membership: Readonly<Record<string, string>>,
  fromKey: string,
  toKey: string,
): Record<string, string> | null {
  const moved = membership[fromKey]
  if (moved === undefined) return null
  if (fromKey === toKey) return null
  const { [fromKey]: _dropped, ...rest } = membership
  // A merge lands the room in the TARGET's zone: the devices are moving into a
  // room that already has a place in the property.
  return toKey in rest ? rest : { ...rest, [toKey]: moved }
}

/**
 * Move a location's description from one key to another, for `renameLocation`.
 *
 * Identical rule to {@link renameLocationIcon}, deliberately: a merge keeps the
 * TARGET's description, because renaming "Sala" into "Hall" moves devices
 * into Hall and does not re-describe it. Split from the icon mover only
 * because the value types differ; if one ever changes, the other must.
 */
function renameLocationDescription(
  descriptions: Readonly<Record<string, string>>,
  fromKey: string,
  toKey: string,
): Record<string, string> | null {
  const moved = descriptions[fromKey]
  if (moved === undefined) return null
  if (fromKey === toKey) return null
  const { [fromKey]: _dropped, ...rest } = descriptions
  return toKey in rest ? rest : { ...rest, [toKey]: moved }
}

/**
 * Move a location's icon from one key to another, for `renameLocation`.
 *
 * Returns `null` when NOTHING changes, so the caller can leave the key out of
 * its `writeAddonStore` patch instead of re-writing an identical map.
 *
 * A rename onto a room that already has an icon is a MERGE, and the surviving
 * room keeps its own: the operator renaming "Sala" into "Hall" is moving
 * devices into Hall, not restyling it. The source key is dropped either way.
 * Pure — builds a new record, mutates nothing.
 */
function renameLocationIcon(
  icons: Readonly<Record<string, IconKey>>,
  fromKey: string,
  toKey: string,
): Record<string, IconKey> | null {
  const moved = icons[fromKey]
  if (moved === undefined) return null
  if (fromKey === toKey) return null
  const { [fromKey]: _dropped, ...rest } = icons
  return toKey in rest ? rest : { ...rest, [toKey]: moved }
}

/**
 * Remove a label from the curated registry. Match is
 * case-insensitive. Devices that still reference this label keep
 * their `meta.location` value (the registry is a suggestion
 * list, not a foreign key) — pass `cascade: true` to also clear
 * `setLocation` on every device that referenced this exact
 * label. Cascade only matches case-insensitively + trimmed, same
 * as the registry equality check.
 */
/**
 * Rename a room in ONE server operation: the registry label in place, then
 * every device that carried it.
 *
 * The lock order is the one `removeLocation` documents and must not be
 * "simplified": the registry edit takes the addon-store lock and RELEASES it
 * before the cascade takes the meta lock. Holding both, in that order, is the
 * reverse of `allocateNextDeviceId`'s meta ⊃ addon-store nesting — the pair
 * that deadlocks.
 *
 * Validation happens BEFORE either lock. A rename that throws halfway is the
 * exact failure this function exists to remove, so an empty target must be
 * refused while nothing has been written yet.
 */
export async function renameLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['renameLocation']>[0],
): ReturnType<IDeviceManagerProvider['renameLocation']> {
  const from = input.from.trim()
  const to = input.to.trim()
  if (from.length === 0) {
    throw new Error('[device-manager] renameLocation: `from` must be non-empty')
  }
  if (to.length === 0) {
    throw new Error('[device-manager] renameLocation: `to` must be non-empty')
  }
  const fromKey = from.toLowerCase()
  const toKey = to.toLowerCase()

  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const current = store.locations ?? []
    const registered = current.some((l) => l.trim().toLowerCase() === fromKey)
    // The ICON moves with the room, and it moves even when the label was never
    // REGISTERED: `setLocationIcon` does not require registration either (the
    // registry is a suggestion list, and the rooms that most need a rename are
    // the ones nobody registered). An early return on `registered` alone would
    // leave the icon parked on a key no location will ever carry again — an
    // orphan that reads as "the icon was lost" and can only be cleared by
    // re-creating the old room.
    const icons = store.locationIcons ?? {}
    const movedIcons = renameLocationIcon(icons, fromKey, toKey)
    // The DESCRIPTION moves on exactly the same terms. It has to be here and
    // not in the addon that reads it: while it lived in post-analysis settings
    // under a hand-typed label, this rename carried the icon and left the
    // description behind, and nothing anywhere said so.
    const descriptions = store.locationDescriptions ?? {}
    const movedDescriptions = renameLocationDescription(descriptions, fromKey, toKey)
    // And the ZONE it belongs to, for the third time and the same reason.
    const membership = store.locationZones ?? {}
    const movedZones = renameLocationZone(membership, fromKey, toKey)
    // `from` was never registered AND carried neither — nothing to rewrite
    // here; the device cascade below is the whole job.
    if (!registered && movedIcons === null && movedDescriptions === null && movedZones === null)
      return
    // Drop BOTH labels and write the target once. Dropping `to` as well is what
    // makes renaming onto an existing room a MERGE rather than a duplicate
    // entry, and it is also what lets a case-only rename (`kitchen` → `Kitchen`)
    // through: there, the two keys are the same one.
    //
    // Position is deliberately not preserved — `listLocations` sorts, so the
    // stored order is not observable and pretending to hold it would be
    // untestable ceremony.
    const kept = current.filter((l) => {
      const key = l.trim().toLowerCase()
      return key !== fromKey && key !== toKey
    })
    await pctx.settings.writeAddonStore({
      ...(registered ? { locations: [...kept, to] } : {}),
      ...(movedIcons !== null ? { locationIcons: movedIcons } : {}),
      ...(movedDescriptions !== null ? { locationDescriptions: movedDescriptions } : {}),
      ...(movedZones !== null ? { locationZones: movedZones } : {}),
    })
  })

  const moved = await pctx.metaStore.withMetaWriteLock(async () => {
    const out: number[] = []
    for (const row of await pctx.metaStore.rows.listAll()) {
      const location = row.meta.location
      if (typeof location !== 'string') continue
      if (location.trim().toLowerCase() !== fromKey) continue
      await pctx.metaStore.rows.patch(row.meta.id, { location: to })
      out.push(row.meta.id)
    }
    return out
  })
  for (const deviceId of moved) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: deviceId },
      category: EventCategory.DeviceMetaChanged,
      data: { deviceId, field: 'location', value: to },
    })
  }
  pctx.host.ctx.logger.info('renameLocation: room renamed', {
    meta: { from, to, moved: moved.length },
  })
  return { moved: moved.length }
}

export async function removeLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeLocation']>[0],
): ReturnType<IDeviceManagerProvider['removeLocation']> {
  const trimmed = input.name.trim()
  if (trimmed.length === 0) return
  // The registry edit takes the addon-store lock and RELEASES it before the
  // cascade takes the meta lock below. Holding both at once, in this order,
  // would be the reverse of `allocateNextDeviceId`'s meta ⊃ addon-store
  // nesting — which is the pair that deadlocks.
  await pctx.bindingsDeps.withAddonStoreWriteLock(async () => {
    const store = await pctx.metaStore.readStore()
    const current = store.locations ?? []
    const key = locationIconKey(trimmed)
    const remaining = current.filter((l) => l.toLowerCase() !== key)
    const droppedLabel = remaining.length !== current.length
    // The icon goes with the room. Leaving it behind is not harmless: the key
    // survives forever in a store nobody lists, and re-creating a room of the
    // same name silently inherits an icon the operator never chose for it.
    const icons = store.locationIcons ?? {}
    const droppedIcon = key in icons
    // Same reasoning for the description, and the stake is higher: a re-created
    // room silently inheriting a description the operator never wrote for it
    // would be fed to a model as fact.
    const descriptions = store.locationDescriptions ?? {}
    const droppedDescription = key in descriptions
    // A removed room leaves its zone. Leaving the entry keeps a key nothing
    // lists, and a room re-created with the same name would silently rejoin a
    // zone nobody put it in.
    const membership = store.locationZones ?? {}
    const droppedZone = key in membership
    if (!droppedLabel && !droppedIcon && !droppedDescription && !droppedZone) return
    const { [key]: _removedIcon, ...keptIcons } = icons
    const { [key]: _removedDescription, ...keptDescriptions } = descriptions
    const { [key]: _removedZone, ...keptMembership } = membership
    await pctx.settings.writeAddonStore({
      ...(droppedLabel ? { locations: remaining } : {}),
      ...(droppedIcon ? { locationIcons: keptIcons } : {}),
      ...(droppedDescription ? { locationDescriptions: keptDescriptions } : {}),
      ...(droppedZone ? { locationZones: keptMembership } : {}),
    })
  })
  if (input.cascade !== true) return

  // The cascade is a read-modify-write over device rows and belongs under the
  // same lock every other device writer takes. It used to run OUTSIDE it: a
  // `setLocation` landing between this scan and its write was silently undone,
  // and a `registerDevice` in the same window had its whole row overwritten by
  // the pre-read snapshot the blob write carried.
  const cleared = await pctx.metaStore.withMetaWriteLock(async () => {
    const out: number[] = []
    for (const row of await pctx.metaStore.rows.listAll()) {
      const location = row.meta.location
      if (typeof location !== 'string') continue
      if (location.trim().toLowerCase() !== trimmed.toLowerCase()) continue
      await pctx.metaStore.rows.patch(row.meta.id, { location: null })
      out.push(row.meta.id)
    }
    return out
  })
  for (const deviceId of cleared) {
    pctx.host.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: deviceId },
      category: EventCategory.DeviceMetaChanged,
      data: { deviceId, field: 'location', value: null },
    })
  }
}
