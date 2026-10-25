import type {
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceContext,
  SavedDevice,
  IDevice,
} from '@camstack/types'
import { BaseDeviceProvider, DeviceType, errMsg } from '@camstack/types'
import type { DeviceSummary, DiscoveryCandidate } from '@camstack/types'
import { OnvifCamera, onvifCameraSchema } from './onvif-camera.js'
import { OnvifClient } from './onvif-client.js'
import { discoverOnvifCameras } from './onvif-discovery.js'
import type { OnvifProviderConfig, DiscoveredOnvifCamera } from './onvif-types.js'

const ADDON_ID = 'provider-onvif'
/** Stored flat, under its dotted schema key — the store is not nested. */
const DISCOVERY_TIMEOUT_KEY = 'discovery.timeout'
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000

/**
 * The global keys `BaseAddon` resolves into `this.config`. `defaultPassword`
 * is a keychain secret (D787): the store holds a marker, and only the base
 * resolve path turns it back into the string discovery needs.
 */
interface OnvifGlobalConfig {
  defaultUsername: string
  defaultPassword: string
}

export class OnvifProviderAddon extends BaseDeviceProvider<OnvifGlobalConfig> {
  protected readonly addonId = ADDON_ID
  protected readonly providerName = 'ONVIF'

  /** Cache of last WS-Discovery scan results — used by adoptDiscoveredDevice */
  private lastDiscovered: readonly DiscoveredOnvifCamera[] = []

  constructor() {
    super({ defaultUsername: '', defaultPassword: '' })
  }

  // ── Discovery (override defaults) ───────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const config = await this._getAddonConfig()
    const timeout = config.discovery?.timeout ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    this.ctx.logger.info('Starting ONVIF discovery', { meta: { timeoutMs: timeout } })

    const cameras = await discoverOnvifCameras(timeout)
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
        username: config.defaultUsername ?? '',
        password: config.defaultPassword ?? '',
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

  // ── Global settings ─────────────────────────────────────────────────
  //
  // The schema is DECLARED, not served by a `getGlobalSettings` override:
  // the keychain save path derives the addon's secret tree from this
  // declaration. With only a getter override the tree was empty and
  // `defaultPassword` was stored as plaintext. The base `getGlobalSettings`
  // hydrates it and shows a stored secret as a view, never as its value;
  // the base `updateGlobalSettings` persists the same bare keys.

  protected override globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'discovery',
          title: 'ONVIF Discovery',
          titleKey: 'provider-onvif:globalSettings.s_discovery.title',
          columns: 2,
          // No on/off switch: a scan runs only when an operator asks for one
          // (Add device, or the discovery modal), and that request is the one
          // control (D777).
          fields: [
            {
              type: 'number',
              key: DISCOVERY_TIMEOUT_KEY,
              label: 'Discovery Timeout',
              unit: 'ms',
              min: 1000,
              max: 30000,
              step: 1000,
              default: DEFAULT_DISCOVERY_TIMEOUT_MS,
            },
          ],
        },
        {
          id: 'credentials',
          title: 'Default Credentials',
          titleKey: 'provider-onvif:globalSettings.s_credentials.title',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'defaultUsername',
              label: 'Default Username',
              labelKey: 'provider-onvif:globalSettings.s_credentials.defaultUsername.label',
            },
            {
              type: 'password',
              key: 'defaultPassword',
              label: 'Default Password',
              labelKey: 'provider-onvif:globalSettings.s_credentials.defaultPassword.label',
              showToggle: true,
            },
          ],
        },
      ],
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async _getAddonConfig(): Promise<OnvifProviderConfig> {
    // Non-secret keys come from the projected store; the default
    // credentials from `this.config`, which BaseAddon resolves through the
    // keychain (a raw read would see the marker object, not the password).
    const raw = await this.resolveGlobalStore()
    const { defaultUsername, defaultPassword } = this.config
    const storedTimeout = raw[DISCOVERY_TIMEOUT_KEY]
    return {
      id: typeof raw['id'] === 'string' ? raw['id'] : 'onvif-default',
      name: typeof raw['name'] === 'string' ? raw['name'] : 'ONVIF Cameras',
      discovery: {
        timeout:
          typeof storedTimeout === 'number' && Number.isFinite(storedTimeout) && storedTimeout > 0
            ? storedTimeout
            : DEFAULT_DISCOVERY_TIMEOUT_MS,
      },
      cameras: raw['cameras'] as OnvifProviderConfig['cameras'],
      defaultUsername: defaultUsername !== '' ? defaultUsername : undefined,
      defaultPassword: defaultPassword !== '' ? defaultPassword : undefined,
    }
  }

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
