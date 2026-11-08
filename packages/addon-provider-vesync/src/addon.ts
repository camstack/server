import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  defaultIntegrationApiOver,
  defineAddonMigrations,
  errMsg,
  EventCategory,
  type IDevice,
  integrationInstancesCapability,
  integrationRowsPortsOver,
  type RecordIntegrationInstances,
  type SavedDevice,
  type SystemEvent,
  type DeviceRestoreReport,
} from '@camstack/types'
import { VESYNC_SYSTEM, type VeSyncConnectionConfig } from './config.js'
import { VeSyncGatewayDevice } from './devices/vesync-gateway-device.js'
import { VeSyncPurifierDevice } from './devices/vesync-purifier-device.js'
import {
  ADDON_MIGRATIONS,
  VESYNC_HUB_MIGRATION_ID,
  VESYNC_ROWS_TO_RECORD_ID,
  VESYNC_ROWS_TO_RECORD_MIGRATION,
  type VeSyncMigrationPorts,
} from './migrations/index.js'
import { restoreAfterMigration } from './migrations/restore-after-migration.js'
import { vesyncAccounts } from './vesync-account-resolver.js'
import { buildVeSyncAdoptionProvider } from './vesync-adoption-provider.js'
import { gatewayStableId } from './vesync-discovery.js'
import {
  buildVeSyncInstances,
  vesyncConnectionOf,
  vesyncConnectionsEntryKind,
  type VeSyncConnectionBody,
  vesyncRecordKinds,
} from './vesync-instances.js'
import {
  cascadeRemoveDevicesForIntegration,
  setIntegrationDevicesOnline,
} from './vesync-integration-devices.js'
import { VeSyncIntegrationManager } from './vesync-integration-manager.js'

/**
 * VeSync cloud-account provider, `mode: account` and broker-less. An integration is one
 * VeSync account: email, password, region and poll interval live on its `connections`
 * record (the password in the keychain). Discovery offers the account as a
 * {@link DeviceType.Gateway} and each air purifier as a {@link DeviceType.Fan} sibling
 * of it. The old Hub device that held `config.connection` is retired by the
 * `provider-vesync` migration (D987), run from {@link onRestoreDevices}.
 */
export class VeSyncProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-vesync'
  protected readonly providerName = 'VeSync'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Fan]: VeSyncPurifierDevice,
    [DeviceType.Gateway]: VeSyncGatewayDevice,
  }

  private instances: RecordIntegrationInstances<VeSyncConnectionBody> | null = null
  private readonly names = new Map<string, string>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.requireRecords()
    await records.declare(vesyncRecordKinds)
    const instances = buildVeSyncInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
    })
    this.instances = instances
    // Rows move before the instances provider registers. The hub migration needs the
    // persisted devices and runs from `onRestoreDevices`. The whole catalogue is declared
    // either way; `only` names the phase.
    this.declareRegistrySwitch({
      kind: vesyncConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(
      this.migrationCatalogue(this.buildMigrationPorts([], async () => undefined)),
      { only: [VESYNC_ROWS_TO_RECORD_ID] },
    )
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        { capability: integrationInstancesCapability, provider: instances.toProvider() },
      ],
    }
  }

  protected override async onShutdown(): Promise<void> {
    for (const id of vesyncAccounts.ids()) {
      const mgr = vesyncAccounts.getManager(id)
      vesyncAccounts.set(id, null)
      if (mgr === null) continue
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('VeSync shutdown: client stop failed', {
          meta: { integrationId: id, error: errMsg(err) },
        })
      }
    }
    vesyncAccounts.clear()
    this.names.clear()
    await super.onShutdown()
  }

  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    return restoreAfterMigration({
      saved: savedDevices,
      migrationId: VESYNC_HUB_MIGRATION_ID,
      logger: this.ctx.logger,
      runMigration: (restoreRows) => {
        const ports = this.buildMigrationPorts(savedDevices, restoreRows)
        return this.runMigrations(this.migrationCatalogue(ports), {
          only: [VESYNC_HUB_MIGRATION_ID],
        })
      },
      restoreRows: async (rows) => {
        await this.reconcileIntegrations()
        await super.onRestoreDevices(rows)
      },
      restoreRest: (rows) => super.onRestoreDevices(rows),
    })
  }

  override async supportsDiscovery(): Promise<boolean> {
    return false
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
    throw new Error('VeSync devices are adopted from the integration')
  }

  protected override generateStableId(type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = stringField(config, 'integrationId')
    if (integrationId.length === 0) {
      throw new Error('vesync generateStableId: integrationId required')
    }
    if (type === DeviceType.Gateway) return gatewayStableId(integrationId)
    const cid = stringField(config, 'purifierNativeId')
    if (cid.length === 0) throw new Error('vesync generateStableId: purifierNativeId required')
    return `${integrationId}:purifier:${cid}`
  }

  private requireRecords() {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-vesync: ctx.records is required (hub-only addon)')
    }
    return records
  }

  private requireInstances(): RecordIntegrationInstances<VeSyncConnectionBody> {
    if (!this.instances) throw new Error('VeSync provider not initialised')
    return this.instances
  }

  private migrationCatalogue(hubPorts: VeSyncMigrationPorts) {
    const records = this.requireRecords()
    const rowsPorts = integrationRowsPortsOver({
      api: defaultIntegrationApiOver(this.ctx.api),
      secrets: this.ctx.secrets ?? null,
      records,
      kind: vesyncConnectionsEntryKind,
      warn: (message) => this.ctx.logger.warn(message),
    })
    return [
      ...defineAddonMigrations(ADDON_MIGRATIONS, hubPorts),
      ...defineAddonMigrations([VESYNC_ROWS_TO_RECORD_MIGRATION], rowsPorts),
    ]
  }

  private buildMigrationPorts(
    saved: readonly SavedDevice[],
    restoreRows: (rows: readonly SavedDevice[]) => Promise<void>,
  ): VeSyncMigrationPorts {
    const devices = this.ctx.kernel.devices
    const records = this.requireRecords()
    const handle = records.kind(vesyncConnectionsEntryKind)
    return {
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      listSavedDevices: async () => saved,
      restoreRows,
      listIntegrations: async () =>
        (await this.ctx.api.integrations.list.query()).map((i) => ({
          id: i.id,
          addonId: i.addonId,
          name: i.name,
          info: i.info,
          ...(i.originStableId !== undefined ? { originStableId: i.originStableId } : {}),
        })),
      createIntegration: async (input) => {
        const created = await this.ctx.api.integrationInstances.createInstance.mutate({
          addonId: input.addonId,
          name: input.name,
          seed: { info: { ...input.info } },
          ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
          values: { ...input.settings },
        })
        return { id: created.id }
      },
      setIntegrationId: async (deviceId, integrationId) => {
        await this.ctx.api.deviceManager.setIntegrationId.mutate({ deviceId, integrationId })
      },
      persistConfig: async (stableId, config) => {
        if (!devices) throw new Error('vesync hub migration: kernel.devices unavailable')
        await devices.persistInitialConfig(stableId, config)
      },
      childIdsOf: async (parentDeviceId) =>
        (await this.ctx.api.deviceManager.getChildren.query({ parentDeviceId })).map((c) => c.id),
      createGateway: async ({ integrationId, name }) => this.adoptGateway(integrationId, name),
      removeDevice: async (deviceId) => {
        await this.ctx.api.deviceManager.remove.mutate({ deviceId })
      },
      putAccountRecord: async (integrationId, body) => {
        const existing = await handle.get(integrationId)
        if (existing !== null) return 'exists'
        const data = vesyncConnectionsEntryKind.schema.parse(body)
        await handle.put({ id: integrationId, data }, { ifRev: 0 })
        return 'created'
      },
      readAccountRecord: async (integrationId) => {
        const row = await handle.getResolved(integrationId)
        return row === null ? null : accountBodyRecord(row.data)
      },
    }
  }

  private async reconcileIntegrations(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        this.names.set(integration.id, integration.name)
        try {
          const read = await vesyncConnectionOf(this.requireInstances(), integration.id)
          if (read === null) {
            this.ctx.logger.warn('VeSync integration has no account record — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          if (read.passwordLocked || read.connection === null) {
            if (vesyncAccounts.getManager(integration.id) !== null) surviving.add(integration.id)
            else {
              this.ctx.logger.warn(
                'VeSync integration password is stored but unreadable — not connecting',
                { meta: { integrationId: integration.id } },
              )
            }
            continue
          }
          await this.ensureManager(integration.id, integration.name, read.connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('VeSync reconcile: failed to read the account record', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
          if (vesyncAccounts.getManager(integration.id) !== null) surviving.add(integration.id)
        }
      }
      for (const id of vesyncAccounts.ids()) {
        if (surviving.has(id)) continue
        const mgr = vesyncAccounts.getManager(id)
        vesyncAccounts.set(id, null)
        this.names.delete(id)
        if (mgr === null) continue
        try {
          await mgr.stop()
        } catch (err) {
          this.ctx.logger.warn('VeSync reconcile: stopping a dropped integration failed', {
            meta: { integrationId: id, error: errMsg(err) },
          })
        }
      }
    } catch (err) {
      this.ctx.logger.warn('VeSync integration reconcile failed', { meta: { error: errMsg(err) } })
    }
  }

  private async ensureManager(
    id: string,
    name: string,
    connection: VeSyncConnectionConfig,
  ): Promise<void> {
    const existing = vesyncAccounts.getManager(id)
    if (existing !== null) {
      if (sameAccount(existing.getConnection(), connection)) return
      await existing.applyConnection(connection)
      return
    }
    const mgr = new VeSyncIntegrationManager({
      id,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: (accountId) => this.markIntegrationOnline(accountId, true),
      onDisconnected: (accountId) => this.markIntegrationOnline(accountId, false),
      onPolled: (accountId) => vesyncAccounts.emitSnapshot(accountId),
    })
    vesyncAccounts.set(id, mgr)
    try {
      await mgr.start()
    } catch (err) {
      this.ctx.logger.warn('VeSync integration login failed — kept for retry', {
        meta: { integrationId: id, error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const on =
      (kind: 'enabled' | 'disabled' | 'deleted') =>
      (event: SystemEvent): void => {
        const addonId = event.data['addonId']
        if (typeof addonId === 'string' && addonId !== this.ctx.id) return
        if (kind === 'enabled') {
          void this.reconcileIntegrations()
          return
        }
        const integrationId = event.data['integrationId']
        if (typeof integrationId !== 'string') return
        void this.dropIntegration(integrationId)
      }
    this.requireInstances().onSwitched((id, enabled) => {
      if (enabled) void this.reconcileIntegrations()
      else void this.dropIntegration(id)
    })
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, on('deleted'))
  }

  private async dropIntegration(integrationId: string): Promise<void> {
    const mgr = vesyncAccounts.getManager(integrationId)
    vesyncAccounts.set(integrationId, null)
    this.names.delete(integrationId)
    if (mgr !== null) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('VeSync: stopping a removed integration failed', {
          meta: { integrationId, error: errMsg(err) },
        })
      }
    }
    await this.cascade(integrationId)
  }

  private async cascade(integrationId: string): Promise<void> {
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

  private markIntegrationOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('VeSync integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }

  private buildAdoptionProvider() {
    return buildVeSyncAdoptionProvider({
      getPurifiers: (integrationId) => vesyncAccounts.getPurifiers(integrationId),
      hasIntegration: (integrationId) => vesyncAccounts.getManager(integrationId) !== null,
      integrationOnline: (integrationId) =>
        vesyncAccounts.getManager(integrationId)?.status === 'connected',
      listIntegrations: () => vesyncAccounts.ids(),
      integrationName: (integrationId) => this.names.get(integrationId) ?? null,
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
      adoptPurifier: async ({ integrationId, cid, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('vesync adopt: kernel.devices unavailable')
        const config: Record<string, unknown> = {
          purifierNativeId: cid,
          integrationId,
          system: VESYNC_SYSTEM,
          ...(model !== undefined ? { model } : {}),
        }
        const stableId = this.generateStableId(DeviceType.Fan, config)
        const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
        if (existing !== undefined) return { deviceId: existing.id }
        const device = await devices.create(stableId, VeSyncPurifierDevice, config, null, {
          type: DeviceType.Fan,
          name,
          integrationId,
        })
        this.ctx.logger.info('VeSync: adopted purifier', {
          tags: { deviceId: device.id },
          meta: { cid, stableId, integrationId },
        })
        return { deviceId: device.id }
      },
      adoptGateway: ({ integrationId, name }) => this.adoptGateway(integrationId, name),
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  private async adoptGateway(
    integrationId: string,
    name: string,
  ): Promise<{ readonly deviceId: number }> {
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('vesync adopt: kernel.devices unavailable')
    const config = {
      kind: 'account' as const,
      integrationId,
      system: VESYNC_SYSTEM,
    }
    const stableId = this.generateStableId(DeviceType.Gateway, config)
    const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
    if (existing !== undefined) return { deviceId: existing.id }
    const device = await devices.create(stableId, VeSyncGatewayDevice, config, null, {
      type: DeviceType.Gateway,
      name,
      integrationId,
    })
    this.ctx.logger.info('VeSync: adopted account gateway', {
      tags: { deviceId: device.id },
      meta: { stableId, integrationId },
    })
    return { deviceId: device.id }
  }
}

function stringField(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function sameAccount(a: VeSyncConnectionConfig, b: VeSyncConnectionConfig): boolean {
  return (
    a.email === b.email &&
    a.password === b.password &&
    a.region === b.region &&
    a.pollIntervalMs === b.pollIntervalMs
  )
}

function accountBodyRecord(data: VeSyncConnectionBody): Record<string, unknown> {
  const out: Record<string, unknown> = { name: data.name }
  if (data.email !== undefined) out['email'] = data.email
  if (data.password !== undefined) out['password'] = data.password
  if (data.region !== undefined) out['region'] = data.region
  if (data.pollIntervalMs !== undefined) out['pollIntervalMs'] = data.pollIntervalMs
  return out
}
