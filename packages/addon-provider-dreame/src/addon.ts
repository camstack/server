import { Nodreame } from '@apocaliss92/nodedreame'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  integrationInstancesCapability,
  type AddonInitResult,
  type RecordIntegrationInstances,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionProbe,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
  userError,
  collectOwnerIntegrationIds,
  rowsDepsOver,
} from '@camstack/types'
import { DreameReconciler, type IntegrationLifecycleKind } from './dreame-reconciler.js'
import { toNodreameOptions } from './config.js'
import {
  buildDreameInstances,
  DREAME_MIGRATIONS,
  dreameConnectionOf,
  type DreameConnectionBody,
  dreameRecordKinds,
  dreameRowsPorts,
  dreameConnectionsEntryKind,
} from './dreame-instances.js'
import { DreameContainerDevice } from './devices/dreame-container-device.js'
import { buildDreameAdoptionProvider } from './dreame-adoption-provider.js'
import { DreameClientRegistry } from './dreame-client-registry.js'
import { buildDreameConnectionTestProvider } from './dreame-connection-test.js'
import { dreameFacades } from './dreame-gateway.js'
import { cascadeRemoveDevicesForIntegration } from './dreame-integration-device-cascade.js'
import { type OfflineTarget, setIntegrationDevicesOnline } from './dreame-integration-offline.js'
import { serveMapImage, setMapBaseUrl } from './dreame-map-store.js'
import { dreameSession } from './dreame-session.js'

/**
 * Dreame device-provider addon — `mode: account` (multi-account, broker-less).
 *
 * Wraps the `@apocaliss92/nodedreame` Dreamehome cloud client. Each Dreame
 * integration carries its own account credentials in its `integration.settings`;
 * the addon holds one {@link DreameIntegrationManager} per `integrationId` in
 * {@link DreameClientRegistry} (`Map<integrationId, manager>`). There is NO
 * shared broker. The live `Nodreame` facade each manager owns is published on
 * the in-process `dreameFacades` resolver KEYED BY `integrationId`.
 *
 * A `device-adoption` cap provider enumerates each account's cloud devices and
 * adopts them; each adopted cloud device becomes a {@link DeviceType.Container}
 * parent that fans out a single typed accessory child (vacuum or mower) and its
 * entity children. The device classes resolve their live handle by the
 * `brokerId` config field — UNCHANGED device-side code; that field now holds the
 * integrationId (see the migration note in the addon docs).
 *
 * `hub-only`: the map data-plane binds 127.0.0.1.
 */
export class DreameProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-dreame'
  protected readonly providerName = 'Dreame'
  // Container is the parent class for the accessory-children model; the vacuum /
  // mower children are spawned via the Container's getAccessoryChildren() and
  // restored by the default Pass-2 "accessory, skip" path.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: DreameContainerDevice,
  }

  private integrationReconciler: DreameReconciler | null = null
  private clients: DreameClientRegistry | null = null
  private instances: RecordIntegrationInstances<DreameConnectionBody> | null = null
  /** Teardown for the `/map` data-plane listener (vacuum-map PNG serving). */
  private mapDataPlaneDispose: (() => Promise<void>) | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-dreame: ctx.records is required (hub-only addon)')
    await records.declare(dreameRecordKinds)
    // Before the provider registers: while it is registered the hub answers from the record.
    this.declareRegistrySwitch({
      kind: dreameConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(DREAME_MIGRATIONS, (api) => dreameRowsPorts({ ...rowsDepsOver(api) }))
    const instances = buildDreameInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })
    this.instances = instances

    dreameSession.bind({
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
    })
    this.clients = new DreameClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Dreame: integration connected', {
        meta: { integrationId },
      })
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    // reconcileIntegrations awaits each manager's login + discovery, so facades
    // are up (and discoverable for adoption) once init completes.
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    await this.setupMapDataPlane()

    this.ctx.logger.info('Dreame: provider initialised', {
      meta: { integrationCount: this.requireClients().size() },
    })

    return {
      providers: [
        ...regs,
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(),
        },
        {
          capability: integrationInstancesCapability,
          provider: instances.toProvider(),
        },
      ],
    }
  }

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on no live
   * client and opens its own throwaway session.
   */
  private buildConnectionTestProvider(): IConnectionProbe {
    return buildDreameConnectionTestProvider({
      makeFacade: (config) => new Nodreame(toNodreameOptions(config)),
      logger: this.ctx.logger,
    })
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.mapDataPlaneDispose?.()
    } catch (err) {
      this.ctx.logger.warn('Dreame: map data-plane dispose error', {
        meta: { error: errMsg(err) },
      })
    }
    this.mapDataPlaneDispose = null
    setMapBaseUrl(null)
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Dreame: provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    this.instances = null
    dreameSession.unbind()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<DreameConnectionBody> {
    if (!this.instances) throw new Error('Dreame provider not initialised')
    return this.instances
  }

  private requireClients(): DreameClientRegistry {
    if (!this.clients) throw new Error('Dreame provider not initialised')
    return this.clients
  }

  /**
   * Register the `/map` data-plane route that streams rendered vacuum-map PNGs
   * to the browser (`<img>` loads `/addon/<addonId>/map?did=…&t=…`). The map
   * child devices write the rendered bytes into the shared store; the public
   * route lets the hub reverse-proxy serve them without a client auth header.
   * Best-effort — a missing data-plane facility (older host) just leaves map
   * URLs null, never blocks init.
   */
  private async setupMapDataPlane(): Promise<void> {
    const dataPlane = this.ctx.dataPlane
    if (!dataPlane) {
      this.ctx.logger.debug('Dreame: no data-plane facility; vacuum-map images disabled')
      return
    }
    try {
      const handle = await dataPlane.serve({
        prefix: 'map',
        access: 'public',
        handler: serveMapImage,
      })
      // CLIENT url = the hub reverse-proxy path, NOT handle.baseUrl (the internal
      // 127.0.0.1 listener, hub-only) — mirrors the recorder/stream-broker addons.
      setMapBaseUrl(`/addon/${this.addonId}/map`)
      this.mapDataPlaneDispose = (): Promise<void> => handle.dispose()
      this.ctx.logger.info('Dreame: vacuum-map data-plane ready', {
        meta: {
          clientBase: `/addon/${this.addonId}/map`,
          internal: handle.baseUrl,
        },
      })
    } catch (err) {
      this.ctx.logger.warn('Dreame: map data-plane setup failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Stable id, integration-scoped so two accounts exposing the same cloud device
   * id don't collide. `brokerId` in the config is the integrationId (unchanged
   * field name).
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['brokerId'] ?? 'unknown')
    const dreameDeviceId = String(config?.['dreameDeviceId'] ?? Date.now())
    return `dreame:${integrationId}:${dreameDeviceId}`
  }

  // ── Per-integration credential reconcile (mirrors Wyze) ─────────────────

  /**
   * Rebuild the `Map<integrationId, manager>` from the live integration list:
   * for each surviving Dreame integration read its settings and upsert a manager
   * (session-preserving if credentials are unchanged); drop managers whose
   * integration was deleted/disabled — cascade-removing their adopted devices.
   * Idempotent; runs on boot + on every integration lifecycle event. Guarded so
   * a failure never fails init.
   */
  private reconciler(): DreameReconciler {
    this.integrationReconciler ??= new DreameReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: {
        list: () => this.requireClients().list(),
        remove: async (id) => {
          await this.requireClients().remove(id)
          await dreameSession.forget(id)
        },
      },
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const connection = await dreameConnectionOf(this.requireInstances(), integration.id)
        if (!connection) return false
        await this.requireClients().upsert(integration.id, integration.name, connection)
        return true
      },
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
      ownerIntegrationIds: () => this.ownerIntegrationIds(),
    })
    return this.integrationReconciler
  }

  /** Upsert one client per enabled integration; never removes a device (D49). */
  private async reconcileIntegrations(): Promise<void> {
    await this.reconciler().reconcile()
  }

  /** Lifecycle events: only an explicit Deleted/Disabled naming an integration removes devices. */
  private subscribeIntegrationLifecycle(): void {
    const on =
      (kind: IntegrationLifecycleKind) =>
      (event: SystemEvent): void => {
        const addonId = event.data['addonId']
        if (typeof addonId === 'string' && addonId !== this.ctx.id) return
        const integrationId = event.data['integrationId']
        void this.reconciler().onLifecycle(
          kind,
          typeof integrationId === 'string' ? integrationId : null,
        )
      }
    this.requireInstances().onSwitched((id, enabled) => {
      void this.reconciler().onLifecycle(enabled ? 'enabled' : 'disabled', id)
    })
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, on('deleted'))
  }

  /** The integrations that own devices here, for the orphan sweep. */
  private async ownerIntegrationIds(): Promise<readonly string[]> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return []
    return await collectOwnerIntegrationIds({
      reg,
      devices,
      addonId: this.addonId,
      ownerOf: (cfg) => {
        const owner = cfg['brokerId']
        return cfg['system'] === 'dreame' && typeof owner === 'string' ? owner : null
      },
    })
  }

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<number> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return 0
    return await cascadeRemoveDevicesForIntegration({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildDreameAdoptionProvider({
      logger: this.ctx.logger,
      getFacade: (integrationId) => dreameFacades.get(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedDreame: async () => {
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
      adoptDevice: async ({ dreameDeviceId, integrationId, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('dreame adopt: kernel.devices unavailable')
        // `brokerId` holds the integrationId (unchanged device-side field name)
        // so the device classes resolve their facade via dreameFacades by this id.
        const config = {
          dreameDeviceId,
          brokerId: integrationId,
          model,
          system: 'dreame',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, DreameContainerDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return {
          deviceId: device.id,
          accessoryDeviceIds: children.map((c) => c.id),
        }
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

  // ── Manual creation: not supported (devices are adopted from the cloud) ──

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw userError(
      'dreame.manual-create-refused',
      undefined,
      'Dreame devices are adopted from the cloud, not created manually',
    )
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setIntegrationDevicesOnline(devices, integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Dreame: integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
