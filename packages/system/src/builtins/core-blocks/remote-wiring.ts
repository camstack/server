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
  type AddonApi,
  type AddonContext,
  DeviceType,
  EMPTY_REMOTE_CONFIG,
  type IScopedLogger,
  type MediaPlayerStatus,
  MediaPlayerStatusSchema,
  type RecordsAccess,
  type RemoteAssumedState,
  RemoteAssumedStateSchema,
  type RemoteConfig,
  RemoteConfigSchema,
  RunningStateStatusSchema,
  type TemplateUser,
} from '@camstack/types'
import { invokeCapOver } from './actions-wiring.js'
import { coreBlocksRecordKinds } from './record-kinds.js'
import {
  RemoteService,
  type RemoteAssumptionStore,
  type RemoteConfigStore,
} from './remote-service.js'
import { TemplatesService, type TemplateUsage } from './templates-service.js'

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
      const parsed = RemoteConfigSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      logger.warn(
        'remote: a stored configuration no longer parses, the device reads as having none',
        {
          tags: { deviceId },
          meta: { issues: parsed.error.issues.length },
        },
      )
      return EMPTY_REMOTE_CONFIG
    },
    write: async (deviceId, config: RemoteConfig) => {
      await settings.writeDeviceStore(deviceId, { [REMOTE_STORE_KEY]: config })
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
        const parsed = RemoteConfigSchema.safeParse(row[REMOTE_STORE_KEY])
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

export function buildRemoteRuntime(deps: RemoteRuntimeDeps): RemoteRuntime {
  const templateRows = deps.records.kind(coreBlocksRecordKinds.templates)
  const templates = new TemplatesService({
    templates: templateRows,
    usage: templateUsageOver(deps.settings, deps.api),
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
    assumptions: remoteAssumptionStoreOver(deps.settings, deps.logger.child('remote')),
    logger: deps.logger.child('remote'),
  })
  return { templates, remote }
}
