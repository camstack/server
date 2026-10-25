import { userError } from '@camstack/types'
import {
  BaseDeviceProvider,
  DeviceType,
  EventCategory,
  connectionTestCapability,
  deviceAdoptionCapability,
  errMsg,
  hydrateSchema,
  isSecretMarker,
  memoizePinnedFfmpeg,
} from '@camstack/types'
import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  CreateDeviceSpec,
  DeviceConstructor,
  IConnectionTestProvider,
  IDevice,
  IDeviceAdoptionProvider,
  ProviderRegistration,
  SavedDevice,
  SystemEvent,
} from '@camstack/types'
import { WyzeClientRegistry } from './client-registry.js'
import type { WyzeCredentials } from './cloud-client.js'
import { WYZE_ADDON_ID } from './constants.js'
import { buildCreationFormSchema } from './creation-schema.js'
import { buildSettingsSchema } from './settings-schema.js'
import { cameraConfigFromCloud, stableIdForMac } from './mapping.js'
import { wyzeCameraSchema } from './schema.js'
import { buildWyzeAdoptionProvider } from './wyze-adoption-provider.js'
import { WyzeCamera as WyzeCameraDevice } from './wyze-camera.js'
import {
  buildWyzeConnectionTestProvider,
  defaultWyzeCloudFacadeFactory,
} from './wyze-connection-test.js'
import { applyWyzeCloudTlsTrust } from './wyze-tls-trust.js'

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Keys the account form declares. They belong to `integration.settings`; in
 * the addon's global store they are stale leftovers.
 */
const GLOBAL_CREDENTIAL_KEYS = ['email', 'password', 'apiKey', 'apiId'] as const

/** A stored value worth removing: a non-empty string or a keychain marker. */
function isStoredValue(v: unknown): boolean {
  return (typeof v === 'string' && v.length > 0) || isSecretMarker(v)
}

/** Extract account credentials from an integration's settings, or null. */
function credentialsFromSettings(settings: Record<string, unknown>): WyzeCredentials | null {
  const email = getString(settings, 'email').trim()
  const password = getString(settings, 'password')
  const apiKey = getString(settings, 'apiKey').trim()
  const apiId = getString(settings, 'apiId').trim()
  if (!email || !password || !apiKey || !apiId) return null
  return { email, password, apiKey, apiId }
}

/**
 * Wyze device-provider addon — `mode: account` (multi-account).
 *
 * Each Wyze integration carries its own account credentials in its
 * `integration.settings`; the addon holds one `WyzeCloudClient` per
 * `integrationId` in {@link WyzeClientRegistry} (`Map<integrationId,
 * WyzeCloudClient>`). There is NO shared broker. A `device-adoption` cap
 * provider enumerates each account's cameras and adopts them; each adopted
 * camera is stamped with its `integrationId` and resolves its account client
 * by that id.
 *
 * Cameras still feed the stream-broker through the `pull-rfc4571`
 * lazy-publish + dial-time `materializeStreamSocket` path — structurally
 * identical to Reolink.
 *
 * `hub-only`: the loopback RFC 4571 server binds 127.0.0.1, so the broker
 * that dials it must be co-resident.
 */
export class WyzeProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = WYZE_ADDON_ID
  protected readonly providerName = 'Wyze'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Camera]: WyzeCameraDevice,
  }

  private clients: WyzeClientRegistry | null = null
  /** This node's PINNED ffmpeg (D540), asked once for every camera's live
   *  snapshot. The snapshot used to spawn a bare `'ffmpeg'` off PATH. */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())

  constructor() {
    super({})
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    // Restore DigiCert Global Root CA before any Wyze cloud fetch. Ubuntu
    // 24.04's ca-certificates dropped it; api.wyzecam.com still chains to it.
    applyWyzeCloudTlsTrust()

    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new WyzeClientRegistry({
      dataDir: this.ctx.dataDir,
      logger: this.ctx.logger,
    })

    // The broker emits this on first dial of a `lazy:rfc4571:` placeholder
    // URL and whenever the upstream rfc4571 socket idle-tears-down. We
    // respond by materialising ONLY the requested camStream — idempotent.
    this.subscribe(
      { category: EventCategory.StreamBrokerOnRequestStreamSourceRefresh },
      (event) => {
        const data = event.data as { deviceId?: number; camStreamId?: string }
        const deviceId = typeof data.deviceId === 'number' ? data.deviceId : null
        if (deviceId === null) return
        void this.refreshDeviceStream(deviceId, data.camStreamId).catch((err: unknown) => {
          this.ctx.logger.warn('refresh of Wyze stream failed', {
            tags: { deviceId },
            meta: { camStreamId: data.camStreamId ?? null, error: errMsg(err) },
          })
        })
      },
    )

    await this.purgeStaleGlobalCredentials().catch((err: unknown) => {
      this.ctx.logger.warn('could not remove stale Wyze credentials from the global store', {
        meta: { error: errMsg(err) },
      })
    })
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    return [
      ...regs,
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
    ]
  }

  protected override async onShutdown(): Promise<void> {
    this.clients?.clear()
    this.clients = null
    await super.onShutdown()
  }

  private requireClients(): WyzeClientRegistry {
    if (!this.clients) throw new Error('Wyze provider not initialised')
    return this.clients
  }

  // ── Per-integration credential reconcile ───────────────────────────────

  /**
   * Rebuild the `Map<integrationId, WyzeCloudClient>` from the live
   * integration list: for each surviving Wyze integration read its settings
   * and upsert a client (session-preserving if credentials are unchanged);
   * drop clients whose integration was deleted/disabled. Idempotent; runs on
   * boot + on every integration lifecycle event. Guarded so a failure never
   * fails init.
   */
  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const credentials = credentialsFromSettings(settings)
          if (!credentials) {
            this.ctx.logger.warn('Wyze integration has no complete credentials — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          reg.upsert(integration.id, credentials)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Wyze reconcile: failed to read integration settings', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      reg.retain(surviving)
    } catch (err) {
      this.ctx.logger.warn('Wyze integration reconcile failed', { meta: { error: errMsg(err) } })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrations()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private async refreshDeviceStream(
    deviceId: number,
    camStreamId: string | undefined,
  ): Promise<void> {
    const dev = this.ctx.kernel.deviceRegistry?.getById(deviceId)
    if (!dev || !(dev instanceof WyzeCameraDevice)) return
    if (!camStreamId) {
      this.ctx.logger.debug(
        'broker requested source refresh without a camStreamId — broker will re-pull the catalog',
        { tags: { deviceId } },
      )
      return
    }
    this.wireCameraDeps(dev)
    await dev.materializeStreamSocket(camStreamId)
  }

  // ── connection-test cap provider ───────────────────────────────────────

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on nothing in
   * {@link WyzeClientRegistry} and opens its own throwaway session (no disk I/O).
   */
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildWyzeConnectionTestProvider({
      makeCloud: defaultWyzeCloudFacadeFactory,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildWyzeAdoptionProvider({
      logger: this.ctx.logger,
      getCameraList: (integrationId, force) =>
        this.requireClients().getCameraList(integrationId, force),
      getLastFetchError: (integrationId) => this.requireClients().getLastFetchError(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptCamera: async ({ integrationId, mac, name }) => {
        const cams = await this.requireClients().getCameraList(integrationId)
        const cam = cams.find((c) => c.mac.toUpperCase() === mac.toUpperCase())
        if (!cam)
          throw new Error(`wyze adopt: camera ${mac} not found on integration ${integrationId}`)
        const config = { ...cameraConfigFromCloud(cam, integrationId), name }
        const parsed = wyzeCameraSchema.parse(config)
        const summary = await this.createDevice({
          type: DeviceType.Camera,
          config: { ...parsed, name, integrationId },
        })
        return { deviceId: summary.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
    })
  }

  // ── Config form (account credentials, rendered by the wizard) ───────────
  //
  // `mode: account`: the wizard's config step fetches this schema via
  // `addonSettings.getGlobalSettings` and renders the account form. The
  // SUBMITTED values are stored PER-INTEGRATION (`integrations.create({
  // addonId, name, settings })`) — the addon reads creds from
  // `integration.settings`, NOT the global store. The global store is only a
  // schema carrier here.
  //
  // The schema is DECLARED (`globalSettingsSchema`), not only served by the
  // `getGlobalSettings` override: the keychain save path (D787) derives the
  // addon's secret tree from the declaration. With only the getter override
  // the tree was empty, so any write of `password` / `apiKey` to this store —
  // the keychain migration's own operator write included — landed as
  // plaintext.

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildSettingsSchema()
  }

  override async getGlobalSettings(): Promise<ConfigUISchemaWithValues> {
    // Deliberately empty values: credentials live per integration, and the
    // global store must never surface (or pre-fill) one.
    return hydrateSchema(this.globalSettingsSchema(), {})
  }

  /**
   * Remove account credentials left in the GLOBAL store. They are dead — the
   * addon reads credentials only from `integration.settings` — and an older
   * build left them there as plaintext. Idempotent: a clean store is not
   * written. Secret keys are cleared through `clearSecrets`, which also drops
   * any keychain value a marker points at.
   */
  protected async purgeStaleGlobalCredentials(): Promise<void> {
    const stored = await this.resolveGlobalStore()
    const present = GLOBAL_CREDENTIAL_KEYS.filter((key) => isStoredValue(stored[key]))
    if (present.length === 0) return
    await this.clearSecrets(present)
    this.ctx.logger.info('Removed stale Wyze credentials from the addon global store', {
      meta: { keys: present },
    })
  }

  // ── Manual creation ────────────────────────────────────────────────────
  //
  // Retained so the create meta carries `integrationId` on adopt (the adopt
  // path routes through `createDevice` → `onCreateDevice`). The operator-facing
  // add-device modal for account mode is the adoption panel, not manual entry.

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Camera) return null
    return buildCreationFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Camera) {
      throw new Error(`Wyze provider does not support device type: ${type}`)
    }
    const name = getString(config, 'name').trim()
    if (!name) throw userError('wyze.camera-name-required', undefined, 'Camera name is required')
    const integrationId = getString(config, 'integrationId').trim()

    // Prefer the freshest cloud blob for this MAC (refreshed IP) from the
    // owning account's client; fall back to the supplied values.
    const mac = getString(config, 'mac').trim()
    let merged = config
    if (mac && integrationId) {
      const cams = await this.requireClients().getCameraList(integrationId)
      const fromCloud = cams.find((c) => c.mac.toUpperCase() === mac.toUpperCase())
      if (fromCloud) merged = { ...config, ...cameraConfigFromCloud(fromCloud, integrationId) }
    }
    const parsed = wyzeCameraSchema.parse({ ...merged, integrationId })

    return {
      meta: {
        type: DeviceType.Camera,
        name,
        ...(integrationId ? { integrationId } : {}),
      },
      config: parsed,
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof WyzeCameraDevice) this.wireCameraDeps(device)
      },
    }
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const mac = config && typeof config['mac'] === 'string' ? config['mac'].trim() : ''
    if (mac) return stableIdForMac(mac)
    throw userError(
      'wyze.camera-mac-required',
      undefined,
      'Wyze: cannot persist a camera without a MAC address',
    )
  }

  // ── Camera dependency wiring ───────────────────────────────────────────

  /**
   * Inject the per-account cloud resolvers into a camera so it can (a) refresh
   * its local IP before each dial and (b) poll cloud events for motion +
   * thumbnails — resolving its account {@link WyzeCloudClient} by the camera's
   * own `integrationId` config, without holding a direct provider reference.
   */
  private wireCameraDeps(camera: WyzeCameraDevice): void {
    const mac = camera.config.get('mac')
    const integrationId = camera.config.get('integrationId')
    camera.setDeps({
      cloud: () => this.clients?.client(integrationId) ?? null,
      resolveFfmpeg: this.pinnedFfmpeg,
      resolveCloudCamera: async () => {
        if (!integrationId) return null
        const cams = await this.requireClients().getCameraList(integrationId)
        return cams.find((c) => c.mac.toUpperCase() === mac.toUpperCase()) ?? null
      },
    })
  }

  // ── Restore ────────────────────────────────────────────────────────────

  override async restoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    await super.restoreDevices(savedDevices)
    const all = this.ctx.kernel.deviceRegistry?.getAll() ?? []
    for (const dev of all) {
      if (dev instanceof WyzeCameraDevice) this.wireCameraDeps(dev)
    }
  }
}
