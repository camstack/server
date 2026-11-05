import { isDualHopper as libIsDualHopper, Nodepetkit } from '@apocaliss92/nodepetkit'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  integrationInstancesCapability,
  type AddonInitResult,
  type RecordIntegrationInstances,
  connectionTestCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
  collectOwnerIntegrationIds,
  rowsDepsOver,
} from '@camstack/types'
import { PetkitReconciler, type IntegrationLifecycleKind } from './petkit-reconciler.js'
import { toNodepetkitOptions, toPetkitCredentials } from './config.js'
import {
  buildPetkitInstances,
  PETKIT_MIGRATIONS,
  petkitConnectionOf,
  type PetkitConnectionBody,
  petkitRecordKinds,
  petkitRowsPorts,
} from './petkit-instances.js'
import { PetkitFeederDevice } from './devices/petkit-feeder-device.js'
import { buildPetkitAdoptionProvider } from './petkit-adoption-provider.js'
import { PetkitClientRegistry } from './petkit-client-registry.js'
import { buildPetkitConnectionTestProvider } from './petkit-connection-test.js'
import { petkitConnections } from './petkit-gateway.js'
import { petkitSession } from './petkit-session.js'

/**
 * PetKit device-provider addon — `mode: account` (multi-account, broker-less).
 *
 * Wraps the `@apocaliss92/nodepetkit` PetKit cloud client. Each PetKit
 * integration carries its own account credentials in its `integration.settings`;
 * the addon holds one {@link PetkitIntegrationManager} per `integrationId` in
 * {@link PetkitClientRegistry}. The live feeder roster + handles each manager
 * owns are published on the in-process {@link petkitConnections} resolver keyed
 * by `integrationId`.
 *
 * A `device-adoption` cap provider enumerates each account's feeders and adopts
 * them; each adopted feeder becomes a single {@link DeviceType.PetFeeder} device
 * that registers the `pet-feeder` cap and resolves its live handle by
 * `(integrationId, petkitDeviceId)`. `hub-only`: PetKit is outbound HTTPS.
 */
export class PetkitProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-petkit'
  protected readonly providerName = 'PetKit'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.PetFeeder]: PetkitFeederDevice,
  }

  private integrationReconciler: PetkitReconciler | null = null
  private clients: PetkitClientRegistry | null = null
  private instances: RecordIntegrationInstances<PetkitConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-petkit: ctx.records is required (hub-only addon)')
    await records.declare(petkitRecordKinds)
    // Before the provider registers: while it is registered the hub answers from the record.
    await this.runMigrations(PETKIT_MIGRATIONS, (api) => petkitRowsPorts({ ...rowsDepsOver(api) }))
    const instances = buildPetkitInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })
    this.instances = instances

    petkitSession.bind({
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
    })
    this.clients = new PetkitClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('PetKit: integration connected', {
        meta: { integrationId },
      })
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('PetKit: provider initialised', {
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
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildPetkitConnectionTestProvider({
      makeFacade: (config) =>
        new Nodepetkit(toPetkitCredentials(config), toNodepetkitOptions(config)),
      logger: this.ctx.logger,
    })
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('PetKit: provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    this.instances = null
    petkitSession.unbind()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<PetkitConnectionBody> {
    if (!this.instances) throw new Error('PetKit provider not initialised')
    return this.instances
  }

  private requireClients(): PetkitClientRegistry {
    if (!this.clients) throw new Error('PetKit provider not initialised')
    return this.clients
  }

  /**
   * Integration-scoped stable id so two accounts exposing the same PetKit device
   * id don't collide.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['integrationId'] ?? 'unknown')
    const petkitDeviceId = String(config?.['petkitDeviceId'] ?? Date.now())
    return `petkit:${integrationId}:${petkitDeviceId}`
  }

  // ── Per-integration credential reconcile (mirrors Dreame) ────────────────

  private reconciler(): PetkitReconciler {
    this.integrationReconciler ??= new PetkitReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: {
        list: () => this.requireClients().list(),
        remove: async (id) => {
          await this.requireClients().remove(id)
          await petkitSession.forget(id)
        },
      },
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const connection = await petkitConnectionOf(this.requireInstances(), integration.id)
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
        const owner = cfg['integrationId']
        return cfg['system'] === 'petkit' && typeof owner === 'string' ? owner : null
      },
    })
  }

  /** Remove every adopted PetKit device belonging to a vanished integration. */
  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<number> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return 0
    let removed = 0
    for (const d of reg.getAllForAddon(this.addonId)) {
      const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
      if (config['system'] === 'petkit' && config['integrationId'] === integrationId) {
        try {
          await devices.remove(d.id)
          removed += 1
        } catch (err) {
          this.ctx.logger.warn('PetKit cascade remove failed', {
            tags: { deviceId: d.id },
            meta: { integrationId, error: errMsg(err) },
          })
        }
      }
    }
    return removed
  }

  // ── device-adoption cap provider ─────────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildPetkitAdoptionProvider({
      logger: this.ctx.logger,
      getInfos: (integrationId) => petkitConnections.getInfos(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedPetkit: async () => {
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
      adoptDevice: async ({ petkitDeviceId, integrationId, petkitDeviceType, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('petkit adopt: kernel.devices unavailable')
        const config = {
          petkitDeviceId,
          integrationId,
          petkitDeviceType,
          isDualHopper: libIsDualHopper(petkitDeviceType),
          model,
          system: 'petkit',
          name,
        }
        const stableId = this.generateStableId(DeviceType.PetFeeder, config)
        const device = await devices.create(stableId, PetkitFeederDevice, config, null, {
          type: DeviceType.PetFeeder,
          name,
          integrationId,
        })
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
    })
  }

  // ── Manual creation: not supported (feeders are adopted from the cloud) ──

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
    throw new Error('PetKit feeders are adopted from the cloud, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    for (const d of reg.getAllForAddon(this.addonId)) {
      if (d.config.get('system') !== 'petkit') continue
      if (d.config.get('integrationId') !== integrationId) continue
      if (d.online === online) continue
      d.markOnline(online)
    }
  }
}
