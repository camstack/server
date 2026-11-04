import type {
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceContext,
  DeviceSummary,
  DiscoveryCandidate,
  DiscoveryHit,
  DiscoveryMode,
  IDevice,
  SavedDevice,
} from '@camstack/types'
import {
  BaseDeviceProvider,
  defaultIntegrationApiOver,
  defaultIntegrationMigrations,
  defaultIntegrationPortsOver,
  defineAddonMigrations,
  DeviceType,
  errMsg,
  integrationInstancesCapability,
} from '@camstack/types'
import type { ProviderRegistration, RecordsAccess } from '@camstack/types'
import { ADDON_MIGRATIONS, PROVIDER_ONVIF_ID } from './migrations/index.js'
import { readRawKeys } from './migrations/drop-keys.js'
import {
  buildOnvifInstances,
  onvifConnectionsEntryKind,
  onvifRecordKinds,
} from './onvif-instances.js'
import { OnvifCamera, onvifCameraSchema } from './onvif-camera.js'
import { OnvifClient } from './onvif-client.js'
import { ONVIF_DISCOVERY_MODES, onvifCamerasFromHits } from './onvif-discovery.js'
import type { DiscoveredOnvifCamera } from './onvif-types.js'

const ADDON_ID = 'provider-onvif'
/** The date of the integration-rows and device-claim migrations (D1007). */
const ONVIF_INTEGRATION_MIGRATIONS_DATE = '2026-11-05'
/** Stored flat, under its dotted schema key — the store is not nested. */

/**
 * The addon has no global settings. The type admits any key only so the migration can clear a
 * retired keychain secret by name (`clearSecrets`).
 */
type OnvifGlobalConfig = Record<string, never>

export class OnvifProviderAddon extends BaseDeviceProvider<OnvifGlobalConfig> {
  protected readonly addonId = ADDON_ID
  protected readonly providerName = 'ONVIF'

  /** Cache of last WS-Discovery scan results — used by adoptDiscoveredDevice */
  private lastDiscovered: readonly DiscoveredOnvifCamera[] = []

  constructor() {
    super({})
  }

  /**
   * Retire the addon-wide default credentials (D986 Q8, D987): clear the password from the
   * keychain, then delete both rows. Nothing reads them; each camera holds its own.
   */
  private async migrateSettings(records: RecordsAccess): Promise<void> {
    // The WHOLE catalogue in one declaration (#417): the two earlier migrations, then the
    // integration rows move into a record and the cameras carrying no integration are claimed (D1007).
    await this.runMigrations([
      ...defineAddonMigrations(ADDON_MIGRATIONS, {
        readStored: (keys) =>
          readRawKeys((key) => this.readStoredGlobalKey(key), PROVIDER_ONVIF_ID, keys),
        clearDefaultPassword: () => this.clearSecrets(['defaultPassword']),
      }),
      ...defineAddonMigrations(
        defaultIntegrationMigrations({
          addonId: ADDON_ID,
          date: ONVIF_INTEGRATION_MIGRATIONS_DATE,
          seq: ADDON_MIGRATIONS.length + 1,
        }),
        defaultIntegrationPortsOver({
          api: defaultIntegrationApiOver(this.ctx.api),
          records,
          kind: onvifConnectionsEntryKind,
          info: (message) => this.ctx.logger.info(message),
          warn: (message) => this.ctx.logger.warn(message),
          warnDevice: (message, deviceId) => this.ctx.logger.warn(message, { tags: { deviceId } }),
        }),
      ),
    ])
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-onvif: ctx.records is required (hub-only addon)')
    await records.declare(onvifRecordKinds)
    // Before the provider registers: while it is registered the hub answers from the record.
    await this.migrateSettings(records)
    return [
      ...this.providerRegistrationsFromSuper(await super.onInitialize()),
      {
        capability: integrationInstancesCapability,
        provider: buildOnvifInstances(records).toProvider(),
      },
    ]
  }

  // ── Discovery (override defaults) ───────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return ONVIF_DISCOVERY_MODES
  }

  /** The engine's WS-Discovery probe finds the cameras; a candidate carries no credentials: each camera holds its own. */
  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const cameras = onvifCamerasFromHits(input.hits)
    this.lastDiscovered = cameras
    this.ctx.logger.info('ONVIF discovery complete', { meta: { cameraCount: cameras.length } })

    return cameras.map((c) => ({
      stableId: `onvif-${c.host.replace(/\./g, '-')}`,
      type: DeviceType.Camera,
      suggestedName: c.name ?? c.host,
      prefilledConfig: {
        name: c.name ?? c.host,
        host: c.host,
        port: c.port,
        username: '',
        password: '',
      },
    }))
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    const candidate = input.candidate
    const expectedHost = candidate.stableId.replace('onvif-', '').replace(/-/g, '.')
    const discovered = this.lastDiscovered.find((c) => c.host === expectedHost)

    const host =
      typeof candidate.prefilledConfig['host'] === 'string'
        ? candidate.prefilledConfig['host']
        : expectedHost
    const port =
      typeof candidate.prefilledConfig['port'] === 'number' ? candidate.prefilledConfig['port'] : 80
    const username =
      typeof candidate.prefilledConfig['username'] === 'string'
        ? candidate.prefilledConfig['username']
        : ''
    const password =
      typeof candidate.prefilledConfig['password'] === 'string'
        ? candidate.prefilledConfig['password']
        : ''
    const name =
      typeof candidate.prefilledConfig['name'] === 'string'
        ? candidate.prefilledConfig['name']
        : host

    const camera = await this._createAndRegisterCamera({
      stableId: candidate.stableId,
      name,
      host,
      port,
      username,
      password,
      manufacturer: discovered?.manufacturer,
      model: discovered?.model,
      firmware: discovered?.firmwareVersion,
    })
    return this.toSummary(camera)
  }

  // ── Creation ─────────────────────────────────────────────────────────

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Camera) return null
    return {
      sections: [
        {
          id: 'connection',
          title: 'ONVIF Camera',
          titleKey: 'provider-onvif:onGetCreation.s_connection.title',
          columns: 1,
          fields: [
            {
              type: 'text',
              key: 'name',
              label: 'Name',
              labelKey: 'provider-onvif:onGetCreation.s_connection.name.label',
              required: true,
            },
            {
              type: 'text',
              key: 'host',
              label: 'Host',
              labelKey: 'provider-onvif:onGetCreation.s_connection.host.label',
              required: true,
              placeholder: '192.168.10.10',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              labelKey: 'provider-onvif:onGetCreation.s_connection.port.label',
              default: 80,
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-onvif:onGetCreation.s_connection.username.label',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-onvif:onGetCreation.s_connection.password.label',
              showToggle: true,
            },
          ],
        },
      ],
    }
  }

  /** OnvifCamera takes (ctx, initialData, client) — incompatible with
   *  BaseDeviceProvider's default deviceClasses lookup. We keep the
   *  manual flow via the overridden `createDevice`. */
  protected readonly deviceClasses = {} as const

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error(
      'ONVIF provider uses an overridden createDevice flow — onCreateDevice should not be called',
    )
  }

  override async createDevice(input: {
    type: DeviceType
    config: Record<string, unknown>
  }): Promise<DeviceSummary> {
    if (input.type !== DeviceType.Camera) {
      throw new Error(`ONVIF provider does not support device type: ${input.type}`)
    }
    const parsed = onvifCameraSchema.parse(input.config)
    const stableId = `onvif-${Date.now()}`
    const camera = await this._createAndRegisterCamera({
      stableId,
      name: parsed.name,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
    })
    return this.toSummary(camera)
  }

  // ── Restore ──────────────────────────────────────────────────────────

  protected override async onRestoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    // Under the bounded restore retry (D347), hydrated from the stored
    // runtime state (D677): a load that did not answer costs a retry, never a
    // camera built on cold defaults.
    await this.restoreWithBoundedRetry(savedDevices, async (saved) => {
      const devices = this.ctx.kernel.devices!
      const id = await devices.allocateDeviceId(saved.stableId)
      const ctx = await this.hydratedContext(saved.stableId, id)
      const camera = new OnvifCamera(ctx, saved.config, null)
      await devices.register(camera)

      this._reconnectCamera(camera, saved.config).catch((err: unknown) => {
        this.ctx.logger.warn('Failed to reconnect ONVIF camera on restore', {
          tags: { deviceId: id },
          meta: { stableId: saved.stableId, error: errMsg(err) },
        })
      })
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * The context a camera is BUILT from, hydrated from its stored runtime state
   * (D677): a load that did not answer rejects rather than building on cold
   * defaults; a new camera's `{}` is an answer. An older kernel has no
   * `loadContext` and builds empty, as before.
   */
  private async hydratedContext(stableId: string, id: number): Promise<DeviceContext> {
    const devices = this.ctx.kernel.devices!
    return devices.loadContext
      ? devices.loadContext(stableId, id)
      : devices.createContext(stableId, id)
  }

  private async _createAndRegisterCamera(opts: {
    stableId: string
    name: string
    host: string
    port?: number
    username?: string
    password?: string
    rtspUrlOverride?: string
    manufacturer?: string
    model?: string
    firmware?: string
  }): Promise<IDevice> {
    const port = opts.port ?? 80
    const username = opts.username ?? ''
    const password = opts.password ?? ''

    const client = new OnvifClient(
      opts.host,
      port,
      username,
      password,
      // Numeric id isn't allocated until below — tag with stableId only
      this.ctx.logger.withTags({ deviceStableId: opts.stableId, cameraName: opts.name }),
    )
    await client.connect()

    const info = await client.getDeviceInfo().catch(() => ({
      manufacturer: opts.manufacturer ?? '',
      model: opts.model ?? '',
      firmwareVersion: opts.firmware ?? '',
      serialNumber: '',
    }))

    const profiles = await client.getProfiles()
    const mainProfile = profiles[0]
    const subProfile = profiles.length > 1 ? profiles[1] : undefined

    const rtspUrl = opts.rtspUrlOverride ?? (await client.getStreamUri(mainProfile?.token))
    const subStreamUrl = subProfile
      ? await client.getStreamUri(subProfile.token).catch(() => '')
      : ''
    let snapshotUrl = ''
    try {
      snapshotUrl = await client.getSnapshotUri(mainProfile?.token)
    } catch {
      /* not supported */
    }

    const initialData: Record<string, unknown> = {
      name: opts.name,
      host: opts.host,
      port,
      username,
      password,
      rtspUrl,
      subStreamUrl,
      snapshotUrl,
      profileToken: mainProfile?.token ?? '',
      subProfileToken: subProfile?.token ?? '',
      videoWidth: mainProfile?.videoWidth,
      videoHeight: mainProfile?.videoHeight,
      subVideoWidth: subProfile?.videoWidth,
      subVideoHeight: subProfile?.videoHeight,
      hasPtz: client.hasPtz(),
      manufacturer: info.manufacturer ?? opts.manufacturer ?? '',
      model: info.model ?? opts.model ?? '',
      firmware: info.firmwareVersion ?? opts.firmware ?? '',
    }

    const devices = this.ctx.kernel.devices!
    const id = await devices.allocateDeviceId(opts.stableId)
    const ctx = await this.hydratedContext(opts.stableId, id)
    const camera = new OnvifCamera(ctx, initialData, client)
    await devices.register(camera)

    this.ctx.logger.info('ONVIF camera registered', {
      tags: { deviceName: opts.name },
      meta: { host: opts.host, ptz: client.hasPtz(), profileCount: profiles.length },
    })
    return camera
  }

  private async _reconnectCamera(
    camera: OnvifCamera,
    savedConfig: Record<string, unknown>,
  ): Promise<void> {
    const host = String(savedConfig['host'] ?? '')
    const port = Number(savedConfig['port'] ?? 80)
    const username = String(savedConfig['username'] ?? '')
    const password = String(savedConfig['password'] ?? '')
    if (!host) return

    const client = new OnvifClient(
      host,
      port,
      username,
      password,
      this.ctx.logger.withTags({ deviceId: camera.id, cameraName: camera.name }),
    )
    await client.connect()
    camera.attachClient(client)
    this.ctx.logger.info('Reconnected ONVIF camera', {
      tags: { deviceId: camera.id, deviceName: camera.name },
      meta: { stableId: camera.stableId, host },
    })
  }
}
