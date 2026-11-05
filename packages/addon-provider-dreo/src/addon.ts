import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  integrationInstancesCapability,
  integrationRowsMigration,
  integrationRowsPortsOver,
  type RecordIntegrationInstances,
  type SystemEvent,
  collectOwnerIntegrationIds,
  rowsDepsOver,
} from '@camstack/types'
import { DreoReconciler, type IntegrationLifecycleKind } from './dreo-reconciler.js'
import { DreoContainerDevice } from './devices/dreo-container-device.js'
import { buildDreoAdoptionProvider } from './dreo-adoption-provider.js'
import { DreoClientRegistry } from './dreo-client-registry.js'
import { buildDreoConnectionTestProvider } from './dreo-connection-test.js'
import { dreoConnections } from './dreo-gateway.js'
import {
  buildDreoInstances,
  dreoConnectionOf,
  dreoConnectionsEntryKind,
  type DreoConnectionBody,
  dreoRecordKinds,
} from './dreo-instances.js'
import { cascadeRemoveDevicesForIntegration } from './dreo-integration-device-cascade.js'
import { defaultFacade } from './dreo-integration-manager.js'
import { type OfflineTarget, setIntegrationDevicesOnline } from './dreo-integration-offline.js'
import { dreoSession } from './dreo-session.js'

/** The date of the integration-rows-to-record migration (D1007). */
const DREO_MIGRATIONS_DATE = '2026-11-05'

/**
 * Dreo device-provider addon — one integration instance per Dreo account (D1007).
 *
 * Wraps the `@apocaliss92/nodedreo` Dreo cloud client (REST + WebSocket). Each
 * Dreo integration is a `connections` record carrying its own account
 * credentials; the addon holds one {@link DreoIntegrationManager} per
 * `integrationId` in {@link DreoClientRegistry} (`Map<integrationId, manager>`).
 * The live connection surface each manager owns
 * (discovery info + per-device handles) is published on the in-process
 * {@link dreoConnections} resolver KEYED BY `integrationId`.
 *
 * A `device-adoption` cap provider enumerates each account's cloud devices and
 * adopts them; each adopted cloud device becomes a {@link DeviceType.Container}
 * parent that fans out a single typed accessory child (fan / purifier / heater /
 * humidifier) and its entity children. The device classes resolve their live
 * handle by the `brokerId` config field persisted on each adopted device; that
 * field holds the integrationId (the name predates integration instances and
 * stays, it is stored).
 *
 * Placement: hub-only — the Dreo cloud is reached over outbound HTTPS + a
 * persistent WebSocket from a single account session; no LAN proximity matters,
 * so (like Dreame) the connection lives on the hub.
 */
export class DreoProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-dreo'
  protected readonly providerName = 'Dreo'
  // Container is the parent class for the accessory-children model; the typed
  // children are spawned via the Container's getAccessoryChildren() and restored
  // by the default Pass-2 "accessory, skip" path.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: DreoContainerDevice,
  }

  private integrationReconciler: DreoReconciler | null = null
  private clients: DreoClientRegistry | null = null
  private instances: RecordIntegrationInstances<DreoConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-dreo: ctx.records is required (hub-only addon)')
    await records.declare(dreoRecordKinds)
    await this.runMigrations(
      [
        integrationRowsMigration({
          addonId: this.addonId,
          date: DREO_MIGRATIONS_DATE,
          kind: dreoConnectionsEntryKind,
          fixtureMark: 'email',
        }),
      ],
      (api) => integrationRowsPortsOver({ ...rowsDepsOver(api), kind: dreoConnectionsEntryKind }),
    )
    this.instances = buildDreoInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })

    dreoSession.bind({
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
    })
    this.clients = new DreoClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Dreo: integration connected', {
        meta: { integrationId },
      })
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    // reconcileIntegrations awaits each manager's login + discovery + connect,
    // so the connection surfaces are up (and discoverable for adoption) once
    // init completes.
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('Dreo: provider initialised', {
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
          capability: connectionTestCapability,
          provider: this.buildConnectionTestProvider(),
        },
        {
          capability: integrationInstancesCapability,
          provider: this.requireInstances().toProvider(),
        },
      ],
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Dreo: provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    dreoSession.unbind()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<DreoConnectionBody> {
    if (!this.instances) throw new Error('Dreo provider not initialised')
    return this.instances
  }

  private requireClients(): DreoClientRegistry {
    if (!this.clients) throw new Error('Dreo provider not initialised')
    return this.clients
  }

  /**
   * Stable id, integration-scoped so two accounts exposing the same cloud device
   * id don't collide. The persisted `brokerId` config field is the integrationId.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['brokerId'] ?? 'unknown')
    const dreoDeviceId = String(config?.['dreoDeviceId'] ?? Date.now())
    return `dreo:${integrationId}:${dreoDeviceId}`
  }

  // ── Per-integration credential reconcile (mirrors Dreame / Wyze) ────────

  /**
   * Rebuild the `Map<integrationId, manager>` from the live integration list:
   * for each surviving Dreo integration read its settings and upsert a manager
   * (session-preserving if credentials are unchanged); drop managers whose
   * integration was deleted/disabled — cascade-removing their adopted devices.
   * Idempotent; runs on boot + on every integration lifecycle event. Guarded so
   * a failure never fails init.
   */
  private reconciler(): DreoReconciler {
    this.integrationReconciler ??= new DreoReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: {
        list: () => this.requireClients().list(),
        remove: async (id) => {
          await this.requireClients().remove(id)
          await dreoSession.forget(id)
        },
      },
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const connection = await dreoConnectionOf(this.requireInstances(), integration.id)
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
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, on('enabled'))
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, on('disabled'))
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
        return cfg['system'] === 'dreo' && typeof owner === 'string' ? owner : null
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

  // ── connection-test cap provider ───────────────────────────────────────

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on nothing in
   * {@link DreoClientRegistry} and opens its own throwaway session.
   */
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildDreoConnectionTestProvider({
      makeFacade: defaultFacade,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildDreoAdoptionProvider({
      registry: dreoConnections,
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedDreo: async () => {
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
      adoptDevice: async ({ dreoDeviceId, integrationId, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('dreo adopt: kernel.devices unavailable')
        // the persisted `brokerId` field holds the integrationId
        // so the device classes resolve their surface via dreoConnections by this id.
        const config = {
          dreoDeviceId,
          brokerId: integrationId,
          model,
          system: 'dreo',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, DreoContainerDevice, config, null, {
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
    throw new Error('Dreo devices are adopted from the cloud, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setIntegrationDevicesOnline(devices, integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Dreo: integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
