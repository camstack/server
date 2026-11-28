import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionProbe,
  type IDevice,
  type IDeviceAdoptionProvider,
  integrationInstancesCapability,
  type RecordIntegrationInstances,
  type SystemEvent,
  collectOwnerIntegrationIds,
} from '@dominevo/types'
import { KiaReconciler, type IntegrationLifecycleKind } from './kia-reconciler.js'
import { KiaVehicleDevice } from './devices/kia-vehicle-device.js'
import { buildKiaAdoptionProvider } from './kia-adoption-provider.js'
import { KiaClientRegistry } from './kia-client-registry.js'
import { buildKiaConnectionTestProvider } from './kia-connection-test.js'
import { kiaConnections } from './kia-gateway.js'
import {
  buildKiaInstances,
  kiaConnectionOf,
  kiaConnectionsEntryKind,
  type KiaConnectionBody,
  kiaRecordKinds,
} from './kia-instances.js'
import { cascadeRemoveDevicesForIntegration } from './kia-integration-device-cascade.js'
import { createKiaBridge } from './kia-bridge.js'
import type { KiaBridgeFactory } from './kia-integration-manager.js'
import { resolveKiaWorker } from './kia-python-paths.js'
import { type OfflineTarget, setIntegrationDevicesOnline } from './kia-integration-offline.js'
import { kiaSession } from './kia-session.js'

/**
 * Kia Connect device-provider addon: one integration instance per Kia account (D1007).
 *
 * Runs the `hyundai-kia-connect-api` cloud library in one Python worker per account
 * (`python/kia_worker.py`, the embedded Python). Each Kia integration is a `connections` record
 * carrying its own account credentials (username, password and PIN, the last two secrets by
 * type); the addon holds one {@link KiaIntegrationManager} per `integrationId` in
 * {@link KiaClientRegistry}. The live connection surface each manager owns (discovery rows and
 * a handle per vehicle) is published on the in-process {@link kiaConnections} resolver KEYED BY
 * `integrationId`.
 *
 * A `device-adoption` cap provider lists each account's vehicles and adopts them; an adopted
 * car is one {@link DeviceType.Vehicle} device (vehicle, location and consumables caps) with
 * lock and climate accessories. The device classes resolve their live handle by the `brokerId`
 * config field persisted on each adopted device; it holds the integrationId (the name predates
 * integration instances and stays, it is stored).
 *
 * The maker cloud answers about two hundred calls a day and has no push channel, so the core
 * reads the account on a 30 minute schedule from the cloud's cache; waking the car is an
 * admin action with a daily budget (see the manager).
 *
 * Placement: hub-only. The cloud is reached over outbound HTTPS from a single account session.
 */
export class KiaProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-kia'
  protected readonly providerName = 'Kia'
  // The car is a top-level Vehicle device; its lock and climate accessories are spawned via
  // its getAccessoryChildren() and restored by the default Pass-2 "accessory, skip" path.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Vehicle]: KiaVehicleDevice,
  }

  private integrationReconciler: KiaReconciler | null = null
  private clients: KiaClientRegistry | null = null
  private instances: RecordIntegrationInstances<KiaConnectionBody> | null = null
  /** The embedded Python, or null with a logged reason: every Kia connection then fails clearly. */
  private pythonPath: string | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-kia: ctx.records is required (hub-only addon)')
    await records.declare(kiaRecordKinds)
    this.pythonPath = await this.resolvePython()
    this.declareRegistrySwitch({
      kind: kiaConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    this.instances = buildKiaInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })

    kiaSession.bind({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
    })
    this.clients = new KiaClientRegistry(this.ctx.logger, { makeBridge: this.bridgeFactory() })
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Kia: integration connected', { meta: { integrationId } })
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

    this.ctx.logger.info('Kia: provider initialised', {
      meta: { integrationCount: this.requireClients().size() },
    })

    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
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
      this.ctx.logger.warn('Kia: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    kiaSession.unbind()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<KiaConnectionBody> {
    if (!this.instances) throw new Error('Kia provider not initialised')
    return this.instances
  }

  private requireClients(): KiaClientRegistry {
    if (!this.clients) throw new Error('Kia provider not initialised')
    return this.clients
  }

  /**
   * Stable id, integration-scoped so two accounts exposing the same cloud device
   * id don't collide. The persisted `brokerId` config field is the integrationId.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['brokerId'] ?? 'unknown')
    const kiaVehicleId = String(config?.['kiaVehicleId'] ?? Date.now())
    return `kia:${integrationId}:${kiaVehicleId}`
  }

  // ── Per-integration credential reconcile (mirrors Dreame / Wyze) ────────

  /**
   * Rebuild the `Map<integrationId, manager>` from the live integration list:
   * for each surviving Kia integration read its settings and upsert a manager
   * (session-preserving if credentials are unchanged); drop managers whose
   * integration was deleted/disabled — cascade-removing their adopted devices.
   * Idempotent; runs on boot + on every integration lifecycle event. Guarded so
   * a failure never fails init.
   */
  private reconciler(): KiaReconciler {
    this.integrationReconciler ??= new KiaReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: {
        list: () => this.requireClients().list(),
        remove: async (id) => {
          await this.requireClients().remove(id)
          await kiaSession.forget(id)
        },
      },
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const connection = await kiaConnectionOf(this.requireInstances(), integration.id)
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
        return cfg['system'] === 'kia' && typeof owner === 'string' ? owner : null
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

  // ── Python worker ───────────────────────────────────────────────────

  private async resolvePython(): Promise<string | null> {
    try {
      const pythonPath = await this.ctx.deps.ensurePython()
      if (pythonPath === null) {
        this.ctx.logger.warn('Kia: embedded Python is unavailable, no Kia account can connect')
      }
      return pythonPath
    } catch (err) {
      this.ctx.logger.warn('Kia: the Python bridge could not be prepared', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /** One new worker per call; throws a clear error when the node has no Python. */
  private bridgeFactory(): KiaBridgeFactory {
    return () => {
      const pythonPath = this.pythonPath
      if (pythonPath === null) {
        throw new Error('Kia needs the embedded Python, which is unavailable on this node')
      }
      return createKiaBridge({ pythonPath, scriptPath: resolveKiaWorker() })
    }
  }

  // ── connection probe ────────────────────────────────────────────────

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on nothing in
   * {@link KiaClientRegistry} and opens its own throwaway session.
   */
  private buildConnectionTestProvider(): IConnectionProbe {
    return buildKiaConnectionTestProvider({
      makeBridge: this.bridgeFactory(),
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildKiaAdoptionProvider({
      registry: kiaConnections,
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedKia: async () => {
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
      adoptDevice: async ({ kiaVehicleId, integrationId, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('kia adopt: kernel.devices unavailable')
        // the persisted `brokerId` field holds the integrationId
        // so the device classes resolve their surface via kiaConnections by this id.
        const config = {
          kiaVehicleId,
          brokerId: integrationId,
          model,
          system: 'kia',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Vehicle, config)
        const device = await devices.create(stableId, KiaVehicleDevice, config, null, {
          type: DeviceType.Vehicle,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
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
    throw new Error('Kia devices are adopted from the cloud, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setIntegrationDevicesOnline(devices, integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Kia: integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
