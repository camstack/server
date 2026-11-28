import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type DeviceRestoreReport,
  type DeviceSummary,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  DeviceType,
  deviceAdoptionCapability,
  errMsg,
  EventCategory,
  type IDevice,
  type IDeviceAdoptionProvider,
  integrationInstancesCapability,
  integrationRowsMigration,
  integrationRowsPortsOver,
  type RecordIntegrationInstances,
  type SavedDevice,
  type SystemEvent,
  collectOwnerIntegrationIds,
  rowsDepsOver,
} from '@dominevo/types'
import { UNIFI_SYSTEM } from './config.js'
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import { buildUnifiAdoptionProvider } from './unifi-adoption-provider.js'
import type { UnifiControllerClientFactory } from './unifi-client-contract.js'
import { makeUnifiClientFactory } from './unifi-client-factory.js'
import { makeUndiciFetch } from './unifi-client-live.js'
import { UnifiUnsupportedError } from './unifi-errors.js'
import { startUnifiWorkerChannel, type UnifiWorkerChannel } from './unifi-worker-channel.js'
import { resolveUnifiWorkerScript, withSecretFile } from './unifi-worker-files.js'
import { UnifiClientRegistry } from './unifi-client-registry.js'
import { buildUnifiDeviceAdopter } from './unifi-device-adopter.js'
import { unifiStableId } from './unifi-discovery.js'
import {
  UNIFI_DISCOVERY_MODES,
  type UnifiDroppedHit,
  unifiConsoleCandidates,
  unifiConsolesFromHits,
} from './unifi-lan-discovery.js'
import { reconcileInfraFeatures } from './unifi-feature-reconcile.js'
import { retireLegacyUnifiGatewayRows } from './unifi-legacy-gateway.js'
import { UnifiReconciler, type IntegrationLifecycleKind } from './unifi-reconciler.js'
import { cascadeRemoveDevicesForIntegration } from './unifi-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './unifi-integration-offline.js'
import {
  buildUnifiInstances,
  unifiConnectionOf,
  unifiConnectionsEntryKind,
  type UnifiConnectionBody,
  unifiRecordKinds,
} from './unifi-instances.js'
import { unifiControllers } from './unifi-node-resolver.js'

/** The date of the integration-rows-to-record migration (D1007). */
const UNIFI_MIGRATIONS_DATE = '2026-11-05'

/**
 * UniFi Network device-provider addon, `mode: account` and broker-less. An integration is one
 * controller: its host, port, credential, site and poll interval live on the integration's
 * settings, and the addon polls it with one client per `integrationId`. The client signs in with
 * the console's API key (the UniFi OS Integration API), a local account (the classic Network API
 * through aiounifi in `python/unifi_worker.py`, with the websocket's live changes), or both —
 * `unifi-client-factory.ts`. Both secrets live in the keychain. The integration declares a
 * connection test (`unifi-connection-test.ts`), and a connection that fails names its reason on
 * the integration's status.
 *
 * Discovery offers each infra device (a {@link DeviceType.Workload} host, fanning per-port PoE,
 * restart and sensors out as accessory children; a console's workload also serves `restart`,
 * and the console is the Host the integration talks to — there is no Gateway, D1064) and each
 * network client ({@link DeviceType.Presence}), all as siblings. Cameras are not in scope.
 *
 * `instanceMode: multiple` — many controllers may be added. A LAN scan finds a UniFi OS console
 * through the Ubiquiti discovery broadcast (`unifi-lan-discovery.ts`) and offers it as an
 * integration to set up, host prefilled; the API key is asked at setup. Access points and
 * switches are never offered: they arrive as children of the adopted console.
 */
export class UnifiProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unifi'
  protected readonly providerName = 'UniFi Network'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: UnifiInfraDevice,
    [DeviceType.Workload]: UnifiInfraDevice,
    [DeviceType.Switch]: UnifiFeatureDevice,
    [DeviceType.Button]: UnifiFeatureDevice,
    [DeviceType.Sensor]: UnifiFeatureDevice,
    [DeviceType.Presence]: UnifiFeatureDevice,
  }

  /**
   * A Gateway row an older version adopted (D1064) has no class: it is retired through the
   * kernel's removal (tombstone, D865) before the rest is restored.
   */
  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    const devices = this.ctx.kernel.devices
    const rest = await retireLegacyUnifiGatewayRows({
      saved: savedDevices,
      remove: async (deviceId) => {
        if (!devices) throw new Error('kernel.devices unavailable')
        await devices.remove(deviceId)
      },
      logger: this.ctx.logger,
    })
    return super.onRestoreDevices(rest)
  }

  private integrationReconciler: UnifiReconciler | null = null
  private clients: UnifiClientRegistry | null = null
  private instances: RecordIntegrationInstances<UnifiConnectionBody> | null = null

  constructor() {
    super({})
  }

  /** The clients over undici (API key) and the aiounifi worker on the embedded Python (account). */
  private clientFactory(): UnifiControllerClientFactory {
    return makeUnifiClientFactory({
      fetchFor: makeUndiciFetch,
      openWorker: () => this.openWorker(),
      secretFiles: withSecretFile,
    })
  }

  private async openWorker(): Promise<UnifiWorkerChannel> {
    const pythonPath = await this.ctx.deps.ensurePython()
    if (pythonPath === null) {
      throw new UnifiUnsupportedError(
        'local-account',
        'unifi: the embedded Python is unavailable, so the local account cannot sign in',
      )
    }
    return startUnifiWorkerChannel({
      pythonPath,
      scriptPath: resolveUnifiWorkerScript(),
      logger: this.ctx.logger,
    })
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-unifi: ctx.records is required (hub-only addon)')
    await records.declare(unifiRecordKinds)
    this.declareRegistrySwitch({
      kind: unifiConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(
      [
        integrationRowsMigration({
          addonId: this.addonId,
          date: UNIFI_MIGRATIONS_DATE,
          kind: unifiConnectionsEntryKind,
          fixtureMark: 'host',
        }),
      ],
      (api) =>
        integrationRowsPortsOver({
          ...rowsDepsOver(api),
          kind: unifiConnectionsEntryKind,
        }),
    )
    this.instances = buildUnifiInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      makeClient: this.clientFactory(),
      statusOf: (id) => this.clients?.statusOf(id) ?? null,
    })
    this.clients = new UnifiClientRegistry(this.ctx.logger, {
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
      onPolled: (integrationId) => this.handlePolled(integrationId),
      makeClient: this.clientFactory(),
    })
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    return {
      providers: [
        ...regs,
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(),
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
      this.ctx.logger.warn('UniFi shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    unifiControllers.clear()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<UnifiConnectionBody> {
    if (!this.instances) throw new Error('UniFi provider not initialised')
    return this.instances
  }

  private requireClients(): UnifiClientRegistry {
    if (!this.clients) throw new Error('UniFi provider not initialised')
    return this.clients
  }

  /** Every device of an integration: `unifi:<integrationId>:<childNativeId>`. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const childNativeId = config?.['childNativeId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('unifi generateStableId: integrationId required')
    }
    if (typeof childNativeId !== 'string' || childNativeId.length === 0) {
      throw new Error('unifi generateStableId: childNativeId required')
    }
    return unifiStableId(integrationId, childNativeId)
  }

  /**
   * Upsert one client per enabled integration and drop the client of one the list ANSWERED is
   * gone. Never removes a device (D49): that follows only an explicit lifecycle event.
   * Idempotent; runs at boot and on every integration lifecycle event.
   */
  private reconciler(): UnifiReconciler {
    this.integrationReconciler ??= new UnifiReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: this.requireClients(),
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const reg = this.requireClients()
        const read = await unifiConnectionOf(this.requireInstances(), integration.id)
        if (read === null) return false
        await reg.upsert(integration.id, integration.name, read.connection, read.credentialsLocked)
        return true
      },
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
      ownerIntegrationIds: () => this.ownerIntegrationIds(),
    })
    return this.integrationReconciler
  }

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
        const owner = cfg['integrationId']
        return cfg['system'] === UNIFI_SYSTEM && typeof owner === 'string' ? owner : null
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

  /** On each poll tick: fan the snapshot out to the devices, and reconcile the infra features. */
  private handlePolled(integrationId: string): void {
    unifiControllers.emitSnapshot(integrationId)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    void reconcileInfraFeatures({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    }).catch((err) => {
      this.ctx.logger.warn('UniFi feature reconcile failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    const adopter = () => {
      const devices = this.ctx.kernel.devices
      if (!devices) throw new Error('unifi adopt: kernel.devices unavailable')
      return buildUnifiDeviceAdopter({ devices })
    }
    return buildUnifiAdoptionProvider({
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => unifiControllers.getManager(integrationId)?.name ?? null,
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const kernelDevices = this.ctx.kernel.devices
        if (!reg || !kernelDevices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await kernelDevices
            .loadConfig(d.id)
            .catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptInfra: async (input) => adopter().adoptInfra(input),
      adoptClient: async (input) => adopter().adoptClient(input),
      childDeviceIds: async (deviceId) => {
        const children = (await this.ctx.kernel.devices?.getChildren(deviceId)) ?? []
        return children.map((c) => c.id)
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const kernelDevices = this.ctx.kernel.devices
        if (!kernelDevices) return null
        return kernelDevices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  // ── LAN discovery: the scan engine finds it, this addon classifies the hits ──

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return UNIFI_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const scan = unifiConsolesFromHits(input.hits)
    const proposal = unifiConsoleCandidates(scan.consoles, await this.knownControllerHosts())
    for (const drop of [...scan.dropped, ...proposal.dropped]) this.logDroppedHit(drop)
    this.ctx.logger.info('UniFi console discovery finished', {
      meta: { found: scan.consoles.length, proposed: proposal.candidates.length },
    })
    return proposal.candidates
  }

  /** A hit the scan did not turn into a candidate is logged with its reason (D391). */
  private logDroppedHit(drop: UnifiDroppedHit): void {
    this.ctx.logger.debug('UniFi discovery: hit not proposed', {
      meta: { host: drop.host, reason: drop.reason, detail: drop.detail ?? null },
    })
  }

  /** The hosts the existing UniFi integrations dial; an unreadable one is skipped and logged. */
  private async knownControllerHosts(): Promise<readonly string[]> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const hosts: string[] = []
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        try {
          const read = await unifiConnectionOf(this.requireInstances(), integration.id)
          if (read !== null) hosts.push(read.connection.host)
        } catch (err) {
          this.ctx.logger.warn('UniFi discovery: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('UniFi discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('A UniFi console is set up as an integration, not added as a device')
  }

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
    throw new Error('UniFi devices are adopted from the integration')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('UniFi integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
