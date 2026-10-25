/**
 * Wiring the async `settings-store` door into `ConfigService` — and replaying
 * the operator's persisted capability preferences once its boot read settles
 * (D675).
 *
 * One function, so the replay cannot be dropped from the wiring without a
 * spec noticing: `setSettingsDoor` starts the ONE boot read of the preloaded
 * `system-settings` keys, and that read's own promise drives a single
 * `applyPersistedPreferences` pass over the providers that registered before
 * it. No timer, no retry (D3). A failed read is logged at error and leaves
 * every preference UNKNOWN until the next boot.
 */
import { type CapabilityRegistry, isInfraCapability } from '@camstack/system'
import { errMsg, type IScopedLogger, type ISettingsStoreProvider } from '@camstack/types'
import type { ConfigService } from '../config/config.service.js'

export interface SettingsDoorWiringDeps {
  readonly configService: ConfigService
  readonly registry: CapabilityRegistry
  readonly logger: IScopedLogger
}

/**
 * Wire `door` and schedule the one preference replay. Returns the replay's
 * promise (it never rejects) so a caller — or a spec — can await it.
 */
export function wireSettingsDoor(
  deps: SettingsDoorWiringDeps,
  door: ISettingsStoreProvider,
): Promise<void> {
  deps.configService.setSettingsDoor(door)
  const preload = deps.configService.whenSystemSettingsPreloaded()
  if (preload === null) return Promise.resolve()
  return preload
    .then((result) => {
      if (result.kind === 'failed') {
        deps.logger.error(
          'capability preferences could not be read at boot — every persisted preference is UNKNOWN until the next boot, and the defaults apply',
          { meta: { error: result.error } },
        )
        return
      }
      const replay = deps.registry.applyPersistedPreferences((capability) =>
        isInfraCapability(capability),
      )
      deps.logger.info('capability preferences loaded from the settings store', {
        meta: {
          keyCount: result.keyCount,
          singletonsApplied: replay.singletons.map((s) => `${s.capability}=${s.addonId}`),
          collectionProvidersDisabled: replay.disabled.map((d) => `${d.capability}/${d.addonId}`),
        },
      })
    })
    .catch((err: unknown) => {
      deps.logger.error('capability preference replay failed', { meta: { error: errMsg(err) } })
    })
}
