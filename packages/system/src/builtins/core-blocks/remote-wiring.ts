/**
 * Builds the `template` and `remote` runtimes out of what core-blocks owns:
 * its records access (the `templates` kind), the per-device settings store
 * (D865: the remote configuration of a device lives under the key `remote`)
 * and the cluster API (a device's type, the native media-player slice, the
 * action a role is bound to).
 *
 * Kept out of `core-blocks.addon.ts` so the seams — the store, the usage
 * finder, the native-state port — are read and specced without booting the
 * addon.
 */
import {
  type IrNativeFormat,
  type AddonApi,
  type AddonContext,
  DeviceType,
  EMPTY_REMOTE_CONFIG,
  type IScopedLogger,
  type MediaPlayerStatus,
  MediaPlayerStatusSchema,
  type RecordsAccess,
  PowerSourceInfoSchema,
  type RemoteAssumedState,
  RemoteAssumedStateSchema,
  type RemoteConfig,
  readStoredRemoteConfig,
  RunningStateStatusSchema,
  type TemplateUser,
} from '@camstack/types'
import { invokeCapOver } from './actions-wiring.js'
import { coreBlocksRecordKinds } from './record-kinds.js'
import {
  RemoteService,
  type RemoteAssumptionStore,
  type RemoteConfigStore,
  type RemoteSliceWriter,
} from './remote-service.js'
import { TemplatesService, type TemplateUsage } from './templates-service.js'
import type { AutomationTemplateInstances } from './automation-template-instances.js'

/** The key of the device's settings store that holds its remote configuration. */
export const REMOTE_STORE_KEY = 'remote'

/** The key that holds what the remote last sent and so guesses; never read as history. */
export const REMOTE_ASSUMED_STORE_KEY = 'remoteAssumed'

type DeviceSettings = Pick<
  NonNullable<AddonContext['settings']>,
  'readDeviceStore' | 'writeDeviceStore' | 'readDeviceStoreBatch' | 'listDeviceStoreIds'
>

export interface RemoteRuntimeDeps {
  readonly records: RecordsAccess
  readonly settings: DeviceSettings
  readonly api: () => AddonApi | undefined
  readonly logger: IScopedLogger
  /** Whether a driver's native media-player cap reads the device (the redirect's predicate). */
  readonly hasNative: (deviceId: number) => boolean
  /** The automations made from a template (#527); absent where no block store runs. */
  readonly automationInstances?: AutomationTemplateInstances
  /** The wait between two sends of a repeat; a spec drives it. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export interface RemoteRuntime {
  readonly templates: TemplatesService
  readonly remote: RemoteService
}

/** A stored row that no longer parses reads as "no remote", loudly, never as a throw. */
export function remoteConfigStoreOver(
  settings: Pick<DeviceSettings, 'readDeviceStore' | 'writeDeviceStore'>,
  logger: IScopedLogger,
): RemoteConfigStore {
  return {
    read: async (deviceId) => {
      const row = await settings.readDeviceStore(deviceId)
      const raw = row[REMOTE_STORE_KEY]
      if (raw === undefined) return EMPTY_REMOTE_CONFIG
      const parsed = readStoredRemoteConfig(raw)
      if (parsed.success) {
        for (const refused of parsed.data.refusedSources ?? []) {
          logger.warn('remote: a stored source no longer parses, it is left out of the remote', {
            tags: { deviceId },
            meta: { index: refused.index, sourceId: refused.id, reason: refused.reason },
          })
        }
        return parsed.data
      }
      logger.warn(
        'remote: a stored configuration no longer parses, the device reads as having none',
        {
          tags: { deviceId },
          meta: { issues: parsed.issues },
        },
      )
      return EMPTY_REMOTE_CONFIG
    },
    write: async (deviceId, config: RemoteConfig) => {
      // `refusedSources` is a read-time report, never part of what is stored.
      const { refusedSources: _report, ...stored } = config
      await settings.writeDeviceStore(deviceId, { [REMOTE_STORE_KEY]: stored })
    },
  }
}

/** A stored guess that no longer parses is forgotten, loudly: it was only a guess. */
export function remoteAssumptionStoreOver(
  settings: Pick<DeviceSettings, 'readDeviceStore' | 'writeDeviceStore'>,
  logger: IScopedLogger,
): RemoteAssumptionStore {
  return {
    read: async (deviceId) => {
      const raw = (await settings.readDeviceStore(deviceId))[REMOTE_ASSUMED_STORE_KEY]
      if (raw === undefined) return null
      const parsed = RemoteAssumedStateSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      logger.warn('remote: a stored assumed state no longer parses, it is forgotten', {
        tags: { deviceId },
      })
      return null
    },
    write: async (deviceId, state: RemoteAssumedState) => {
      await settings.writeDeviceStore(deviceId, { [REMOTE_ASSUMED_STORE_KEY]: state })
    },
  }
}

/**
 * The `running-state` reading of a device: true/false when a source answers,
 * null when the device has none, it errors, or the value is unknown (D393) —
 * unknown is never coerced to "off".
 */
export function runningStateOver(
  api: () => AddonApi | undefined,
  logger: IScopedLogger,
): (deviceId: number) => Promise<boolean | null> {
  return async (deviceId) => {
    const current = api()
    if (current === undefined) return null
    try {
      const parsed = RunningStateStatusSchema.safeParse(
        await current.runningState.getStatus.query({ deviceId }),
      )
      return parsed.success ? parsed.data.running : null
    } catch (err: unknown) {
      logger.debug('remote: no running-state reading for the device', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}

/**
 * The linked plug of a device (`power-source`): its switch state, null when no
 * plug is linked, it errors, or the state is unknown (D393) — never "off".
 */
export function plugOnOver(
  api: () => AddonApi | undefined,
  logger: IScopedLogger,
): (deviceId: number) => Promise<boolean | null> {
  return async (deviceId) => {
    const current = api()
    if (current === undefined) return null
    try {
      const parsed = PowerSourceInfoSchema.safeParse(
        await current.powerSource.getStatus.query({ deviceId }),
      )
      return parsed.success && parsed.data.linked ? parsed.data.switchOn : null
    } catch (err: unknown) {
      logger.debug('remote: no power-source reading for the device', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}

/** The native code formats a transmitter replays; empty when it does not answer. */
export function nativeFormatsOver(
  api: () => AddonApi | undefined,
  logger: IScopedLogger,
): (transmitterId: number) => Promise<readonly IrNativeFormat[]> {
  return async (transmitterId) => {
    const current = api()
    if (current === undefined) return []
    try {
      const info = await current.irTransmitter.getInfo.query({ deviceId: transmitterId })
      return info.formats
    } catch (err: unknown) {
      logger.debug('remote: the transmitter did not report its formats, sending a pulse train', {
        tags: { deviceId: transmitterId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    }
  }
}

/** The devices whose remote configuration points at a template. */
export function templateUsageOver(
  settings: Pick<DeviceSettings, 'listDeviceStoreIds' | 'readDeviceStoreBatch'>,
  api: () => AddonApi | undefined,
): TemplateUsage {
  return {
    devicesUsing: async (templateId) => {
      const ids = await settings.listDeviceStoreIds()
      if (ids.length === 0) return []
      const rows = await settings.readDeviceStoreBatch(ids)
      const users: TemplateUser[] = []
      for (const [deviceId, row] of rows) {
        const parsed = readStoredRemoteConfig(row[REMOTE_STORE_KEY])
        if (!parsed.success || parsed.data.layoutTemplateId !== templateId) continue
        const found = await api()?.deviceManager.getDevice.query({ deviceId })
        users.push({ deviceId, name: found?.name ?? `#${deviceId}` })
      }
      return users
    },
  }
}

/**
 * The native media-player slice, only when a running source READS it. A slice
 * the dispatch hook synthesised from the remote itself (`assumed`) is not a
 * reading and must not be fed back as one.
 */
export function reportedStatusOver(
  api: () => AddonApi | undefined,
  logger: IScopedLogger,
): (deviceId: number) => Promise<MediaPlayerStatus | null> {
  return async (deviceId) => {
    const current = api()
    if (current === undefined) return null
    try {
      const parsed = MediaPlayerStatusSchema.safeParse(
        await current.mediaPlayer.getStatus.query({ deviceId }),
      )
      return parsed.success && parsed.data.stateSource === 'reported' ? parsed.data : null
    } catch (err: unknown) {
      logger.debug('remote: no native media-player status for the device', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}

/** The cap whose runtime slice the remote writes for a device no native source reads. */
const MEDIA_PLAYER_CAP = 'media-player'

/** A slice says the same when only its change stamp moved. */
function sameStatus(a: MediaPlayerStatus, b: MediaPlayerStatus): boolean {
  return JSON.stringify({ ...a, lastChangedAt: 0 }) === JSON.stringify({ ...b, lastChangedAt: 0 })
}

/**
 * The standard runtime-state path (`deviceState.setCapSlice`, the entry every
 * `setCapState` reaches). The current slice is read back from the hub, never
 * kept here, so a write that would change nothing is skipped without a cache.
 */
export function remoteSliceWriterOver(
  settings: Pick<DeviceSettings, 'readDeviceStoreBatch' | 'listDeviceStoreIds'>,
  api: () => AddonApi | undefined,
): RemoteSliceWriter {
  return {
    devices: async () => {
      const ids = await settings.listDeviceStoreIds()
      if (ids.length === 0) return []
      const rows = await settings.readDeviceStoreBatch(ids)
      const carrying: number[] = []
      for (const [deviceId, row] of rows) {
        if (readStoredRemoteConfig(row[REMOTE_STORE_KEY]).success) carrying.push(deviceId)
      }
      return carrying
    },
    publish: async (deviceId, status) => {
      const current = api()
      if (current === undefined) throw new Error('no ctx.api on this node')
      const kept = MediaPlayerStatusSchema.safeParse(
        await current.deviceState.getCapSlice.query({ deviceId, capName: MEDIA_PLAYER_CAP }),
      )
      if (kept.success && sameStatus(kept.data, status)) return
      await current.deviceState.setCapSlice.mutate({
        deviceId,
        capName: MEDIA_PLAYER_CAP,
        slice: { ...status },
      })
    },
  }
}

/** The device of the linked plug (`power-source`), null when none is linked or it errors. */
export function plugDeviceOver(
  api: () => AddonApi | undefined,
): (deviceId: number) => Promise<number | null> {
  return async (deviceId) => {
    const current = api()
    if (current === undefined) return null
    try {
      const parsed = PowerSourceInfoSchema.safeParse(
        await current.powerSource.getStatus.query({ deviceId }),
      )
      return parsed.success && parsed.data.linked ? parsed.data.switchDeviceId : null
    } catch {
      return null
    }
  }
}

/** The caps whose change can move the assumed state: the plug's switch and a running-state. */
export const REMOTE_SLICE_INPUT_CAPS: ReadonlySet<string> = new Set(['switch', 'running-state'])

/**
 * Seeds every remote device's slice ONCE at boot. No retry timer (D3): a read
 * that fails changes nothing, and `DeviceRegistered` and the input events
 * re-drive the refresh.
 */
export async function seedRemoteSlices(
  remote: Pick<RemoteService, 'refreshSlices'>,
  logger: IScopedLogger,
): Promise<void> {
  try {
    await remote.refreshSlices()
  } catch (error) {
    logger.warn('remote: the media-player slices could not be seeded at boot', {
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
}

export function buildRemoteRuntime(deps: RemoteRuntimeDeps): RemoteRuntime {
  const templateRows = deps.records.kind(coreBlocksRecordKinds.templates)
  const templates = new TemplatesService({
    templates: templateRows,
    usage: templateUsageOver(deps.settings, deps.api),
    ...(deps.automationInstances === undefined ? {} : { automations: deps.automationInstances }),
    logger: deps.logger.child('templates'),
  })
  const remote = new RemoteService({
    store: remoteConfigStoreOver(deps.settings, deps.logger.child('remote')),
    invoke: invokeCapOver(deps.api),
    templateExists: async (id) => (await templateRows.get(id)) !== null,
    isMediaPlayer: async (deviceId) => {
      const found = await deps.api()?.deviceManager.getDevice.query({ deviceId })
      return found?.type === DeviceType.MediaPlayer
    },
    reportedStatus: reportedStatusOver(deps.api, deps.logger.child('remote')),
    runningState: runningStateOver(deps.api, deps.logger.child('remote')),
    nativeFormats: nativeFormatsOver(deps.api, deps.logger.child('remote')),
    plugOn: plugOnOver(deps.api, deps.logger.child('remote')),
    assumptions: remoteAssumptionStoreOver(deps.settings, deps.logger.child('remote')),
    slice: remoteSliceWriterOver(deps.settings, deps.api),
    hasNative: deps.hasNative,
    plugDeviceOf: plugDeviceOver(deps.api),
    logger: deps.logger.child('remote'),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  return { templates, remote }
}
