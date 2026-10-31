import {
  addonPagesSourceCapability,
  type AddonInitResult,
  BaseDeviceProvider,
  bestLocationMatch,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  type DeviceSummary,
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IAddonPageProvider,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SavedDevice,
  type SystemEvent,
} from '@camstack/types'
import type { CcuActionDeps } from './ccu/ccu-facade.js'
import { buildCcuDevicesHandlers } from './ccu/ccu-devices-actions.js'
import { buildCcuHeatingHandlers } from './ccu/ccu-heating-actions.js'
import { HOMEMATIC_PAGES } from './ccu/ccu-page.js'
import { buildCcuOverviewHandlers } from './ccu/ccu-overview-actions.js'
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { homematicActions } from './custom-actions.js'
import { HmContainerDevice } from './devices/hm-container-device.js'
import { hmChildDeviceClass } from './devices/hm-child-class-factory.js'
import { isStandaloneEntitySaved } from './devices/hm-standalone-entity.js'
import { HomematicGatewayDevice } from './devices/homematic-gateway-device.js'
import { buildHmAdoptionProvider } from './homematic-adoption-provider.js'
import {
  ccusFromHits,
  HOMEMATIC_DISCOVERY_MODES,
  homematicDiscoveryCandidates,
  homematicDiscoverySummary,
  proposeHomematicCcus,
} from './homematic-ccu-discovery.js'
import { HmClientRegistry } from './homematic-client-registry.js'
import { buildHomematicConnectionTestProvider } from './homematic-connection-test.js'
import { homematicFacades } from './homematic-facade-resolver.js'
import { cascadeRemoveDevicesForIntegration } from './homematic-integration-device-cascade.js'
import { type OfflineTarget, setIntegrationDevicesOnline } from './homematic-integration-offline.js'

/**
 * Homematic CCU3 / RaspberryMatic: `mode: account`, one integration per CCU.
 *
 * The integration holds the connection (host, interfaces, callback, optional
 * WebUI credentials in the keychain, TLS) and owns one live `nodehomematic`
 * session per enabled integration ({@link HmClientRegistry}). Adoption offers
 * the CCU box ({@link DeviceType.Gateway}) and its products (a Container per
 * CCU device, or standalone entities); none of them is a child of the gateway.
 * Adopted devices are keyed on an integration-scoped stable id
 * (`hm:${integrationId}:...`) so reconnects and reboots reuse the existing rows.
 */
export class HomematicProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-homematic'
  protected readonly providerName = 'Homematic'
  // Container is the parent class for the accessory-children model: it
  // declares `getAccessoryChildren()` so the kernel auto-spawns + reconciles
  // one child per functional entity. Accessory children are NOT mapped here:
  // they fall through the default `onRestoreDevices` Pass 2 as "accessory,
  // skip" and the parent Container rebuilds them on restore.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: HomematicGatewayDevice,
    [DeviceType.Container]: HmContainerDevice,
  }

  /** Live per-integration CCU sessions, or null before init / after shutdown. */
  private clients: HmClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof homematicActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new HmClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Homematic: CCU connected', { meta: { integrationId } })
      this.setIntegrationDevicesOnline(integrationId, true)
      // Containers that restored while the CCU was unreachable left
      // `lastProbedAt === 0` (see HmContainerDevice.onProbe). Reprobe now that
      // the facade is populated so accessory children spawn/reconcile.
      void this.reprobeIntegrationContainers(integrationId)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('Homematic: provider initialised', {
      meta: { integrationCount: this.clients.list().length },
    })

    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
        { capability: addonPagesSourceCapability, provider: this.buildPagesProvider() },
      ],
      customActions: homematicActions,
      actionHandlers: {
        ...buildCcuOverviewHandlers(this.ccuActionDeps()),
        ...buildCcuDevicesHandlers(this.ccuActionDeps()),
        ...buildCcuHeatingHandlers(this.ccuActionDeps()),
        discoverCcu: async () => {
          const { candidates } = await this.ctx.api.deviceManager.discoverProvider.mutate({
            addonId: this.ctx.id,
          })
          const hosts = candidates.map((candidate) => ({
            host: String(candidate.prefilledConfig['host'] ?? ''),
            name: candidate.suggestedName,
            id: candidate.stableId.replace(/^homematic:/, ''),
          }))
          return { hosts, summary: homematicDiscoverySummary(hosts.length, hosts.length) }
        },
      },
    }
  }

  /** The CCU management page, mirroring the manifest `pages[]` entry. */
  private buildPagesProvider(): IAddonPageProvider {
    return { id: this.addonId, listPages: () => HOMEMATIC_PAGES }
  }

  /** What the CCU management actions reach: connected sessions only, never a half-started facade. */
  private ccuActionDeps(): CcuActionDeps {
    return {
      facade: (integrationId) => {
        const connected = this.clients
          ?.sessions()
          .some((session) => session.id === integrationId && session.status === 'connected')
        return connected === true ? homematicFacades.get(integrationId) : null
      },
      integrations: () => {
        const clients = this.clients
        if (clients === null) return []
        const connectedIds = new Set(
          clients
            .sessions()
            .filter((session) => session.status === 'connected')
            .map((session) => session.id),
        )
        return clients.list().map((integrationId) => ({
          integrationId,
          name: clients.getName(integrationId) ?? integrationId,
          connected: connectedIds.has(integrationId),
        }))
      },
      logger: this.ctx.logger,
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Homematic: provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    homematicFacades.clear()
    await super.onShutdown()
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  /**
   * Stable id, integration-scoped so two CCUs exposing the same device address
   * never collide: the CCU box `hm:<integration>:gateway`, a standalone entity
   * `hm:<integration>:entity:<address>#<key>`, a Container `hm:<integration>:<address>`.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('provider-homematic generateStableId: integrationId required')
    }
    const hmAddress = config?.['hmAddress'] ?? config?.['address']
    if (typeof hmAddress !== 'string' || hmAddress.length === 0) {
      return `hm:${integrationId}:gateway`
    }
    const entityKey = config?.['hmEntityKey']
    if (typeof entityKey === 'string' && entityKey.length > 0) {
      return `hm:${integrationId}:entity:${hmAddress}#${entityKey}`
    }
    return `hm:${integrationId}:${hmAddress}`
  }

  // ── discovery (LAN scan, pre-fills the integration form) ───────────────

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  /** A CCU is found by the scan engine's http-probe; this addon classifies the hits. */
  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return HOMEMATIC_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const found = ccusFromHits(input.hits)
    const proposals = proposeHomematicCcus(found, await this.knownCcuHosts())
    this.ctx.logger.info('Homematic CCU discovery finished', {
      meta: { found: found.length, proposed: proposals.length },
    })
    return homematicDiscoveryCandidates(proposals)
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('A Homematic CCU is added from the integration form')
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Homematic devices are adopted from the integration, not created manually')
  }

  private async knownCcuHosts(): Promise<readonly string[]> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const hosts: string[] = []
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const connection = connectionFromSettings(settings)
          if (connection) hosts.push(connection.host)
        } catch (err) {
          this.ctx.logger.warn('Homematic discovery: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('Homematic discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  // ── restore ────────────────────────────────────────────────────────────

  /**
   * Homematic restore is two-shaped (mirrors the HA addon).
   *
   * The default `BaseDeviceProvider.onRestoreDevices` resolves a top-level row's
   * class strictly from `deviceClasses[type]`, which for Homematic only maps
   * `Container → HmContainerDevice`. A STANDALONE entity device (adopted via the
   * `entities` granularity) persists with an ENTITY device-type (Switch /
   * Sensor / EventEmitter / Update / …) NOT in that map — so the default pass
   * would skip it (warn + continue) and it would silently vanish on reboot.
   *
   * Partition the rows: standalone entity devices are re-instantiated here via
   * `kernel.devices.create(stableId, hmChildDeviceClass, {})` — the SAME create
   * primitive (and captured cap-re-derive rebuild factory) the `adopt('entities')`
   * path uses, so the dispatcher re-derives the concrete child class from the
   * persisted `config.capabilities`. Everything else (Container parents +
   * accessory children) is delegated to the default pass unchanged: container
   * accessory children carry a `parentDeviceId` and an entity device-type not in
   * `deviceClasses`, so the default Pass 2 cleanly skips them and the parent
   * Container's `getAccessoryChildren()` rebuilds them.
   */
  protected override async onRestoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    const standalone: SavedDevice[] = []
    const rest: SavedDevice[] = []
    for (const saved of savedDevices) {
      if (isStandaloneEntitySaved(saved)) standalone.push(saved)
      else rest.push(saved)
    }

    // Under the bounded restore retry (D347): a build refused on a
    // runtime-state load that did not answer (D677) is retried, not lost
    // until a restart.
    await this.restoreWithBoundedRetry(standalone, async (saved) => {
      await this.ctx.kernel.devices.create(saved.stableId, hmChildDeviceClass, {})
    })

    await super.onRestoreDevices(rest)
  }

  // ── integration reconcile ──────────────────────────────────────────────

  /**
   * Mirror the enabled integrations of this addon into live CCU sessions: open
   * or update one for each (an unchanged connection is left alone), close the
   * ones whose integration is gone or disabled and cascade-remove their adopted
   * devices. Idempotent; runs on boot and on every integration lifecycle event.
   * Guarded: a failing read warns and returns, `onInitialize` must not fail.
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
          const connection = connectionFromSettings(settings)
          if (!connection) {
            this.ctx.logger.warn(
              'Homematic reconcile: host missing or invalid, no session opened',
              {
                tags: { integrationId: integration.id },
              },
            )
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Homematic reconcile: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      for (const integrationId of vanished) {
        await this.cascadeRemoveDevicesForIntegration(integrationId)
      }
    } catch (err) {
      this.ctx.logger.warn('Homematic integration reconcile failed', {
        meta: { error: errMsg(err) },
      })
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

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForIntegration({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    })
  }

  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildHomematicConnectionTestProvider({ logger: this.ctx.logger })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  /**
   * Build the `device-adoption` cap provider. The operator picks the CCU box
   * and which enumerated CCU devices to adopt; nothing is auto-created.
   * `adoptDevice` creates a {@link DeviceType.Container} parent whose
   * `getAccessoryChildren()` auto-spawns one accessory child per functional
   * entity, then fetches them to return their real ids. `integrationId` is
   * stamped into config (our own offline filter + cascade) and into meta (so the
   * core `removeByIntegration` cascade fires on integration delete).
   */
  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildHmAdoptionProvider({
      registry: this.requireClients(),
      logger: this.ctx.logger,
      isOnline: (integrationId) =>
        homematicFacades.getSession(integrationId)?.getInfo().status === 'connected',
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          // Only top-level (parent) devices: children, if any, cascade.
          if (d.parentDeviceId !== null) continue
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptGateway: async ({ integrationId, nativeId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('homematic adopt: kernel.devices unavailable')
        const config = { integrationId, system: 'homematic' as const, nativeId }
        const stableId = this.generateStableId(DeviceType.Gateway, config)
        const device = await devices.create(stableId, HomematicGatewayDevice, config, null, {
          type: DeviceType.Gateway,
          name,
          integrationId,
        })
        return { deviceId: device.id }
      },
      adoptDevice: async ({ hmAddress, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) {
          throw new Error('homematic adopt: kernel.devices unavailable')
        }
        // Adoption ALWAYS creates a Container parent; the inferred `type` is for
        // the candidate icon only. Stamp both `address` (read by HmContainerDevice)
        // and `hmAddress` (the adopted-state scan + cascade key).
        const config = {
          address: hmAddress,
          hmAddress,
          system: 'homematic',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, HmContainerDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
      },
      adoptStandaloneEntity: async ({ deviceType, role, name, integrationId, config }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) {
          throw new Error('homematic adopt entity: kernel.devices unavailable')
        }
        // The class is the cap-re-derive dispatcher (`hmChildDeviceClass`), which
        // reads `config.capabilities` to pick the concrete child class on create
        // and on every captured rebuild.
        const stableId = this.generateStableId(deviceType, config)
        const meta = {
          type: deviceType,
          name,
          integrationId,
          ...(role !== null ? { role } : {}),
        }
        const device = await devices.create(stableId, hmChildDeviceClass, config, null, meta)
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      listLocations: async () => this.ctx.api.deviceManager.listLocations.query(),
      assignLocation: async (deviceId, externalLocation, knownLocations) =>
        this.assignImportedLocation(deviceId, externalLocation, knownLocations),
    })
  }

  /**
   * Best-effort: resolve an imported CCU room to a CamStack location and assign
   * it to a freshly-adopted device. Reuses an existing CamStack location via
   * fuzzy match (`bestLocationMatch`), otherwise creates a new label.
   *
   * Takes the known-locations list and returns the possibly-extended list so
   * the caller can thread it across candidates in one adopt call (a label
   * created here is reused — never created twice in the same call).
   *
   * A location failure NEVER fails the adopt — any error is logged and the
   * unchanged known-locations list is returned.
   */
  private async assignImportedLocation(
    deviceId: number,
    externalLocation: string,
    knownLocations: readonly string[],
  ): Promise<readonly string[]> {
    try {
      const match = bestLocationMatch(externalLocation, knownLocations)
      const name = match ?? externalLocation
      let locations = knownLocations
      if (match === null) {
        await this.ctx.api.deviceManager.addLocation.mutate({ name })
        locations = [...knownLocations, name]
      }
      await this.ctx.api.deviceManager.setLocation.mutate({ deviceId, location: name })
      return locations
    } catch (err) {
      this.ctx.logger.warn('homematic adopt: location import failed (non-fatal)', {
        meta: { deviceId, externalLocation, error: errMsg(err) },
      })
      return knownLocations
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Set every adopted Homematic device of `integrationId` to the requested
   * online state and log a summary when any devices actually transitioned.
   * No-ops when `deviceRegistry` is not yet available.
   */
  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setIntegrationDevicesOnline(devices, integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Homematic: integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }

  /**
   * Reprobe every adopted {@link HmContainerDevice} for `integrationId` so the
   * kernel re-runs accessory reconcile against the live facade. Best-effort:
   * one container's failure must not block the rest (same discipline as HA's
   * post-connect reconcile).
   */
  private async reprobeIntegrationContainers(integrationId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const containers = reg
      .getAllForAddon(this.addonId)
      .filter(
        (d): d is HmContainerDevice =>
          d instanceof HmContainerDevice && d.config.get('integrationId') === integrationId,
      )
    for (const container of containers) {
      try {
        await container.reprobe()
      } catch (err: unknown) {
        this.ctx.logger.warn('Homematic: container reprobe failed', {
          tags: { deviceId: container.id },
          meta: { integrationId, error: errMsg(err) },
        })
      }
    }
  }

  private requireClients(): HmClientRegistry {
    if (!this.clients) throw new Error('Homematic provider not initialised')
    return this.clients
  }
}
