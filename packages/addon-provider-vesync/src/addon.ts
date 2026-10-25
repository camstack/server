import { userError } from '@camstack/types'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  type IDevice,
  errMsg,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  settingsToConnection,
  slugifyEmail,
  type VeSyncConnectionConfig,
  vesyncConnectionSchema,
} from './config.js'
import { VeSyncAccountDevice } from './devices/vesync-account-device.js'
import { VeSyncPurifierDevice } from './devices/vesync-purifier-device.js'
import { vesyncAccounts } from './vesync-account-resolver.js'
import { VeSyncIntegrationManager } from './vesync-integration-manager.js'

/**
 * VeSync cloud-account device-provider addon — `mode: standalone` (the Reolink /
 * Velux / Ecowitt pattern). No broker, no device-adoption cap. An account is
 * added as a DEVICE via the manual-creation form: the CREDENTIALS (email /
 * password / region / poll interval) live on the account DEVICE config. The
 * created account is a {@link DeviceType.Hub} ({@link VeSyncAccountDevice}) that
 * owns its own live client and registers `device-discovery` to adopt its own
 * air purifiers as {@link DeviceType.Fan} devices (each fanning out
 * child-lock / display Switch + air-quality / filter-life Sensor accessories).
 *
 * NOTE: the VeSync client library (`tsvesync`) is DECLARED as a dependency but
 * the adapter is not wired yet (see `plan-vesync.md`) — the integration
 * manager's default factory throws until the `VeSyncClient` adapter over
 * `tsvesync` is implemented, so a created account installs cleanly but stays
 * offline. Everything else (config, discovery flow, cap surface) is complete and
 * type-checked.
 *
 * `instanceMode: multiple` — many accounts may be added. Network auto-discovery
 * is not applicable (VeSync is a cloud account, not a LAN device).
 */
export class VeSyncProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-vesync'
  protected readonly providerName = 'VeSync'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: VeSyncAccountDevice,
    [DeviceType.Fan]: VeSyncPurifierDevice,
  }

  constructor() {
    super({})
  }

  // ── No network auto-discovery for the account itself ────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  // ── Manual creation: an account is added as a Hub device ────────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the account is manually creatable; its purifier children are spawned
    // by the account's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`VeSync provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('vesync.name-required', undefined, 'Account name is required')

    const connection = extractConnection(config)
    if (connection.email.trim().length === 0) {
      throw userError('vesync.email-required', undefined, 'Account email is required')
    }

    // Build the live client ONCE here so the account device adopts a warm client.
    // With no adapter wired, `start()` throws — caught + logged, the device is
    // kept so the row persists for when the adapter lands.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new VeSyncIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (accountId) => vesyncAccounts.emitSnapshot(accountId),
    })
    vesyncAccounts.set(stableId, manager)
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('VeSync create: initial login failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'vesync-account' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof VeSyncAccountDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * Account stableId — derived from the account email (Reolink-style identity
   * key). Re-adding the same account reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = readConnection(config)
    const email = connection?.email.trim() ?? ''
    if (email.length > 0) return `vesync:${slugifyEmail(email)}`
    throw new Error('VeSync: account resolved no email — cannot persist a stable row key.')
  }
}

/** Narrow the create-spec / stable-id config's `connection` to a validated config. */
function extractConnection(config: Record<string, unknown>): VeSyncConnectionConfig {
  return settingsToConnection(config['connection'] ?? config)
}

/** Best-effort connection read for `generateStableId` (no throw on partial input). */
function readConnection(
  config: Record<string, unknown> | undefined,
): VeSyncConnectionConfig | null {
  if (config === undefined) return null
  const raw = config['connection'] ?? config
  const parsed = vesyncConnectionSchema.safeParse(
    typeof raw === 'object' && raw !== null ? raw : {},
  )
  return parsed.success ? parsed.data : null
}
