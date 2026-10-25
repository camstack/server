/**
 * device-manager's side of `device-removal-hook` (D865): tell every implementer
 * a device was deleted, and answer the admin question "which stored data belongs
 * to devices that no longer exist?".
 *
 * Two entry points, one rule: **an implementer is told to delete only on a
 * recorded delete (a tombstone), or on an explicit operator confirm.** Nothing
 * here infers a deletion from a device being absent from a single read.
 */
import {
  clearDeviceSettings,
  listDeviceSettingsScopes,
} from '../../kernel/device-settings-store.js'
import {
  type CleanupDeletedDevicesResult,
  type DeviceDataEntry,
  type DeviceRemovedInput,
  type DeviceRemovedResult,
  errMsg,
  type IScopedLogger,
  type OrphanDeviceData,
  type SettingsStoreClient,
} from '@camstack/types'
import type { RemovalCleanup, RemovalStep } from './removal-cleanup.js'

/** The capability name implementers register under. */
export const DEVICE_REMOVAL_HOOK_CAP = 'device-removal-hook'

/** The slice of `ctx.api` this module uses — a pin is the `addonId` selector. */
export interface RemovalHookApi {
  readonly addons: {
    readonly listCapabilityProviders: {
      query(input: { capName: string }): Promise<readonly { readonly addonId: string }[]>
    }
  }
  readonly deviceRemovalHook: {
    readonly onDeviceRemoved: {
      mutate(input: DeviceRemovedInput & { addonId: string }): Promise<DeviceRemovedResult>
    }
    readonly listDeviceData: {
      query(input: { addonId: string }): Promise<readonly DeviceDataEntry[]>
    }
  }
}

async function hookProviders(api: RemovalHookApi): Promise<readonly string[]> {
  const providers = await api.addons.listCapabilityProviders.query({
    capName: DEVICE_REMOVAL_HOOK_CAP,
  })
  return providers.map((p) => p.addonId)
}

export interface RemovalHookDeps {
  readonly api: RemovalHookApi | undefined
  readonly logger: IScopedLogger
  readonly cleanup: RemovalCleanup
}

/**
 * The removal step that calls every implementer. Each implementer is its own
 * nested step, so a failing one is retried by the bounded reconcile without
 * re-calling the others. Failing to ENUMERATE the implementers throws, and the
 * outer cleanup retries the whole step.
 */
export function removalHookStep(deps: RemovalHookDeps, input: DeviceRemovedInput): RemovalStep {
  return {
    store: 'removal-hooks',
    run: async () => {
      const api = deps.api
      if (api === undefined) {
        deps.logger.warn('removal hooks not called — no api on this context', {
          tags: { deviceId: input.deviceId },
        })
        return 0
      }
      const addonIds = await hookProviders(api)
      if (addonIds.length === 0) return 0
      const steps: RemovalStep[] = addonIds.map((addonId) => ({
        store: `hook:${addonId}`,
        run: async () => {
          const result = await api.deviceRemovalHook.onDeviceRemoved.mutate({ ...input, addonId })
          return Object.values(result.counts).reduce((sum, n) => sum + n, 0)
        },
      }))
      const report = await deps.cleanup.run(input.deviceId, steps)
      return Object.values(report.counts).reduce((sum, n) => sum + n, 0)
    },
  }
}

/** Why a cleanup refuses to list or delete anything. */
export type AbsenceCheck =
  | { readonly ok: true; readonly known: ReadonlySet<number> }
  | { readonly ok: false; readonly reason: string }

export interface AbsenceReads {
  /** One read of the device ledger: its ids and the row count the engine reports. */
  readonly readFleet: () => Promise<{ readonly ids: readonly number[]; readonly rowCount: number }>
}

/**
 * The ids device-manager knows, from TWO consistent reads (D49). Refuses when a
 * read throws, answers empty (an empty fleet and a failed read look the same),
 * or returns fewer ids than the ledger has rows (a malformed row is skipped by
 * the decoder, and a device skipped is a device whose data would be deleted).
 * The known set is the UNION of both reads: an id is absent only when BOTH
 * reads lack it.
 */
export async function checkFleetTwice(reads: AbsenceReads): Promise<AbsenceCheck> {
  const known = new Set<number>()
  for (const attempt of [1, 2]) {
    let read: Awaited<ReturnType<AbsenceReads['readFleet']>>
    try {
      read = await reads.readFleet()
    } catch (err: unknown) {
      return { ok: false, reason: `device list read ${attempt} failed: ${errMsg(err)}` }
    }
    if (read.ids.length === 0) {
      return { ok: false, reason: `device list read ${attempt} answered empty` }
    }
    if (read.ids.length !== read.rowCount) {
      return {
        ok: false,
        reason: `device list read ${attempt} returned ${read.ids.length} of ${read.rowCount} rows`,
      }
    }
    for (const id of read.ids) known.add(id)
  }
  return { ok: true, known }
}

/** Stores holding data for devices that are not in `known`, grouped per device. */
export function orphanDevices(
  held: readonly (readonly [string, DeviceDataEntry])[],
  known: ReadonlySet<number>,
): { readonly devices: readonly OrphanDeviceData[]; readonly idSpaceMismatch: boolean } {
  const byDevice = new Map<number, Record<string, number>>()
  const holders = new Set<number>()
  let overlap = 0
  for (const [, entry] of held) {
    if (!holders.has(entry.deviceId)) {
      holders.add(entry.deviceId)
      if (known.has(entry.deviceId)) overlap += 1
    }
  }
  for (const [addonId, entry] of held) {
    if (known.has(entry.deviceId) || entry.count === 0) continue
    const stores = byDevice.get(entry.deviceId) ?? {}
    stores[`${addonId}:${entry.store}`] = (stores[`${addonId}:${entry.store}`] ?? 0) + entry.count
    byDevice.set(entry.deviceId, stores)
  }
  // A read that knows NONE of the many ids holding data is a defect (the id
  // space drifted), not a fleet-wide deletion (D72).
  const idSpaceMismatch = holders.size >= 5 && overlap === 0
  const devices = [...byDevice.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([deviceId, stores]) => ({ deviceId, stores }))
  return { devices, idSpaceMismatch }
}

/** Every addon's per-device settings scopes, read and cleared centrally (D865). */
export interface SettingsScopeAccess {
  /** One entry per (device, addon) holding settings; throws on a failed or truncated read. */
  list(): Promise<readonly { readonly deviceId: number; readonly addonId: string }[]>
  /** Delete every addon's scope of one device; resolves to the rows deleted. */
  clear(deviceId: number): Promise<number>
}

export interface CleanupDeps {
  readonly api: RemovalHookApi | undefined
  readonly settings: SettingsScopeAccess | undefined
  readonly logger: IScopedLogger
  readonly reads: AbsenceReads
  readonly now?: () => number
}

/** The admin "Clean data of deleted devices" action: dry run unless `confirm`. */
export async function cleanupDeletedDevicesData(
  deps: CleanupDeps,
  input: { readonly confirm: boolean },
): Promise<CleanupDeletedDevicesResult> {
  const skipped = (reason: string, unreachable: readonly string[] = []) => {
    deps.logger.warn('cleanup of deleted devices data skipped — nothing listed or deleted', {
      meta: { reason },
    })
    return { status: 'skipped' as const, reason, devices: [], unreachable: [...unreachable] }
  }
  const api = deps.api
  if (api === undefined) return skipped('no api on this context')

  const fleet = await checkFleetTwice(deps.reads)
  if (!fleet.ok) return skipped(fleet.reason)

  let addonIds: readonly string[]
  try {
    addonIds = await hookProviders(api)
  } catch (err: unknown) {
    return skipped(`implementers could not be listed: ${errMsg(err)}`)
  }

  const unreachable = new Set<string>()
  const held: (readonly [string, DeviceDataEntry])[] = []
  for (const addonId of addonIds) {
    try {
      for (const entry of await api.deviceRemovalHook.listDeviceData.query({ addonId })) {
        held.push([addonId, entry])
      }
    } catch (err: unknown) {
      unreachable.add(addonId)
      deps.logger.warn('cleanup of deleted devices data: an implementer did not answer', {
        meta: { addonId, error: errMsg(err) },
      })
    }
  }
  if (deps.settings !== undefined) {
    try {
      for (const scope of await deps.settings.list()) {
        held.push(['settings', { store: scope.addonId, deviceId: scope.deviceId, count: 1 }])
      }
    } catch (err: unknown) {
      return skipped(`device settings could not be listed: ${errMsg(err)}`, [...unreachable])
    }
  }
  const { devices, idSpaceMismatch } = orphanDevices(held, fleet.known)
  if (idSpaceMismatch) {
    return skipped(
      'none of the device ids holding data is a known device — the id space looks wrong, refusing',
      [...unreachable],
    )
  }
  if (!input.confirm) {
    deps.logger.info('cleanup of deleted devices data: dry run', {
      meta: { devices: devices.length, unreachable: [...unreachable] },
    })
    return { status: 'dry-run', reason: null, devices: [...devices], unreachable: [...unreachable] }
  }

  const now = (deps.now ?? ((): number => Date.now()))()
  const cleaned: OrphanDeviceData[] = []
  for (const device of devices) {
    const deleted: Record<string, number> = {}
    for (const addonId of addonIds) {
      try {
        const result = await api.deviceRemovalHook.onDeviceRemoved.mutate({
          addonId,
          deviceId: device.deviceId,
          deletedAt: now,
          providerAddonId: 'unknown',
        })
        for (const [store, count] of Object.entries(result.counts)) {
          deleted[`${addonId}:${store}`] = count
        }
      } catch (err: unknown) {
        deps.logger.warn('cleanup of deleted devices data: an implementer failed', {
          tags: { deviceId: device.deviceId },
          meta: { addonId, error: errMsg(err) },
        })
      }
    }
    if (
      deps.settings !== undefined &&
      Object.keys(device.stores).some((k) => k.startsWith('settings:'))
    ) {
      try {
        deleted['settings'] = await deps.settings.clear(device.deviceId)
      } catch (err: unknown) {
        deps.logger.warn('cleanup of deleted devices data: settings not cleared', {
          tags: { deviceId: device.deviceId },
          meta: { error: errMsg(err) },
        })
      }
    }
    deps.logger.info('cleaned data of a device deleted before tombstones', {
      tags: { deviceId: device.deviceId },
      meta: { counts: deleted },
    })
    cleaned.push({ deviceId: device.deviceId, stores: deleted })
  }
  return { status: 'cleaned', reason: null, devices: cleaned, unreachable: [...unreachable] }
}

/** Scope access over the settings store; undefined when the store is unavailable. */
export function settingsScopes(
  store: Pick<SettingsStoreClient, 'query' | 'deleteWhere'> | undefined,
): SettingsScopeAccess | undefined {
  if (store === undefined) return undefined
  const door = {
    query: (input: Parameters<SettingsStoreClient['query']['query']>[0]) =>
      store.query.query(input),
    deleteWhere: (input: Parameters<SettingsStoreClient['deleteWhere']['mutate']>[0]) =>
      store.deleteWhere.mutate(input),
  }
  return {
    list: () => listDeviceSettingsScopes(door),
    clear: (deviceId) => clearDeviceSettings(door, deviceId),
  }
}
