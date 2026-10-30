import {
  BaseDeviceProvider,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type AddonInitResult,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type DeviceSummary,
  type DiscoveryCandidate,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
} from '@camstack/types'
import { buildIntegrationFormSchema, ESPHOME_DEFAULT_PORT, type EspAddonConfig } from './config.js'
import { espBrokersEntryKind } from './broker-record-kinds.js'
import { EspBrokerStore } from './esphome-broker-store.js'
import { EspBrokerRegistry } from './esphome-registry.js'
import { buildEspAdoptionProvider } from './esphome-adoption-provider.js'
import {
  cascadeRemoveDevicesForBroker,
  setBrokerDevicesOnline,
  type OfflineTarget,
} from './esphome-broker-devices.js'
import { clientLinkFactory } from './esphome-client-link.js'
import { browseBoards, proposeBoards } from './esphome-discovery.js'
import { EspIntegrationBoards, type AddBoardInput } from './esphome-integration-boards.js'
import { EspContainerDevice } from './devices/esp-container-device.js'
import { EspServiceRunner } from './esphome-services.js'
import { espIrOverrides, loadIrOverrides } from './esphome-ir-overrides.js'
import { espServiceActions } from './custom-actions.js'
import type { EspServiceArgValue, EspServiceInfo } from './esphome-link.js'

export { espServiceActions as customActions } from './custom-actions.js'

const DEFAULTS: EspAddonConfig = {}

/**
 * ESPHome device-provider addon. An integration holds a list of boards and the
 * registry keeps one live native-API session per board; `device-adoption` turns
 * each connected board into its own container with one child per entity, and the
 * LAN scan proposes boards that announce themselves.
 */
export class ESPHomeProviderAddon extends BaseDeviceProvider<EspAddonConfig> {
  protected readonly addonId = 'provider-esphome'
  protected readonly providerName = 'ESPHome'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: EspContainerDevice,
  }

  private registry: EspBrokerRegistry | null = null
  private services: EspServiceRunner | null = null
  private brokerStore: EspBrokerStore | null = null
  private integrationBoards: EspIntegrationBoards | null = null

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof espServiceActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-esphome: ctx.records is required (hub-only addon)')
    }
    // The single-board layout kept its boards here; read once, to move them.
    await records.declare({ brokers: espBrokersEntryKind })
    this.brokerStore = EspBrokerStore.of(records)
    await this.loadAllIrOverrides()

    this.registry = new EspBrokerRegistry({
      factory: clientLinkFactory,
      logger: this.ctx.logger,
      onConnected: (brokerId) => {
        this.setBrokerDevicesOnline(brokerId, true)
        void this.reprobeBrokerContainers(brokerId)
      },
      onDisconnected: (brokerId) => this.setBrokerDevicesOnline(brokerId, false),
    })
    const registry = this.registry
    this.integrationBoards = new EspIntegrationBoards({
      addonId: this.ctx.id,
      api: {
        listIntegrations: async () => {
          const all = await this.ctx.api.integrations.list.query()
          return all.map((i) => ({ id: i.id, addonId: i.addonId, enabled: i.enabled }))
        },
        getSettings: (id) => this.ctx.api.integrations.getSettings.query({ id }),
        setSettings: (input) => this.ctx.api.integrations.setSettings.mutate(input),
      },
      sessions: registry,
      legacy: this.brokerStore,
      cascadeRemoveDevices: (boardId) => this.cascadeRemoveDevicesForBroker(boardId),
      logger: this.ctx.logger,
    })
    // Does not wait for any board to answer: an unreachable board must not hold
    // the addon's boot, and it retries on its own bounded schedule.
    await this.settleBoards()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('ESPHome: provider initialised', {
      meta: { boardCount: this.requireBoards().boards().length },
    })

    this.services = new EspServiceRunner({
      getLink: (brokerId) => registry.getLink(brokerId),
      logger: this.ctx.logger,
    })

    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      ],
      customActions: espServiceActions,
      actionHandlers: {
        listServices: async (input) => this.listServices(input.brokerId),
        executeService: async (input) => {
          await this.executeService(input.brokerId, input.name, input.args)
          return { ok: true }
        },
      },
    }
  }

  /** The user-defined services a connected board exposes. Throws {@link EspServiceError} when it is not connected. */
  listServices(boardId: string): readonly EspServiceInfo[] {
    return this.requireServices().listServices(boardId)
  }

  /** Run a board's service; `deviceId` tags the log line when a device asks. */
  executeService(
    boardId: string,
    name: string,
    args: Readonly<Record<string, EspServiceArgValue>>,
    deviceId?: number,
  ): Promise<void> {
    return this.requireServices().executeService(boardId, name, args, deviceId)
  }

  private requireServices(): EspServiceRunner {
    if (!this.services) throw new Error('ESPHome provider not initialised')
    return this.services
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.registry?.shutdown()
    } catch (err: unknown) {
      this.ctx.logger.warn('ESPHome: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.registry = null
    await super.onShutdown()
  }

  /** Board-scoped, so two boards can never collide on one id. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = String(config?.['brokerId'] ?? 'unknown')
    return `esp:${brokerId}:board`
  }

  // ── per-board transmitter override (device settings store) ──────────────

  protected override deviceSettingsSchema(): ConfigUISchema | null {
    return this.schema({
      sections: [
        {
          id: 'esp-ir',
          title: 'Infrared / RF transmitters',
          columns: 1,
          fields: [
            {
              type: 'tags' as const,
              key: 'irServices',
              label: 'Transmitter services',
              description:
                'API services of this board that become transmitters. Leave unset for automatic ' +
                '(every service whose only argument is an int[]). Write a name, or name:rf for a ' +
                'radio transmitter. Setting the list empty removes every transmitter.',
            },
          ],
        },
      ],
    })
  }

  /** Only a board container has a transmitter list; its children and other devices show nothing. */
  override async getDeviceSettings(deviceId: number): Promise<ConfigUISchemaWithValues> {
    if (this.containerById(deviceId) === undefined) return { sections: [] }
    return super.getDeviceSettings(deviceId)
  }

  override async updateDeviceSettings(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await super.updateDeviceSettings(deviceId, patch)
    const container = this.containerById(deviceId)
    if (container === undefined) return
    await this.loadIrOverridesFor([deviceId])
    await container.reprobe()
  }

  private containerById(deviceId: number): EspContainerDevice | undefined {
    return this.ctx.kernel.deviceRegistry
      ?.getAllForAddon(this.addonId)
      .find((d): d is EspContainerDevice => d instanceof EspContainerDevice && d.id === deviceId)
  }

  private async loadAllIrOverrides(): Promise<void> {
    const settings = this.ctx.settings
    if (settings === undefined) return
    await this.loadIrOverridesFor(await settings.listDeviceStoreIds())
  }

  private async loadIrOverridesFor(deviceIds: readonly number[]): Promise<void> {
    const settings = this.ctx.settings
    if (settings === undefined) return
    await loadIrOverrides({
      deviceIds,
      overrides: espIrOverrides,
      logger: this.ctx.logger,
      readStores: (ids) => settings.readDeviceStoreBatch(ids),
    })
  }

  // ── LAN scan ────────────────────────────────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const found = await browseBoards()
    const known = this.requireBoards()
      .boards()
      .map((b) => b.connection.host)
    return proposeBoards(found, known).map((board) => ({
      stableId: `esphome:${board.id}`,
      type: DeviceType.Hub,
      suggestedName: board.name,
      prefilledConfig: { host: board.host, port: board.port || ESPHOME_DEFAULT_PORT },
    }))
  }

  /**
   * Add a scanned board to an ESPHome integration and adopt it as its own
   * container. The integration is `candidate.prefilledConfig.integrationId`, or
   * the only ESPHome integration when the candidate names none.
   */
  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    const { candidate } = input
    const host = candidate.prefilledConfig?.['host']
    if (typeof host !== 'string' || host.length === 0) {
      throw new Error('ESPHome scan candidate carries no host')
    }
    const port = candidate.prefilledConfig?.['port']
    const integrationId = await this.targetIntegration(candidate.prefilledConfig?.['integrationId'])
    const board = await this.addBoardToIntegration(integrationId, {
      host,
      ...(typeof port === 'number' ? { port } : {}),
      name: candidate.suggestedName,
    })
    const created = await this.adoptBoardContainer({
      brokerId: board.id,
      integrationId,
      name: board.name,
      boardName: board.name,
    })
    const device = this.ctx.kernel.deviceRegistry
      ?.getAllForAddon(this.addonId)
      .find((d) => d.id === created.deviceId)
    if (device === undefined) throw new Error(`ESPHome board ${board.id}: device not registered`)
    return this.toSummary(device)
  }

  /**
   * Add a board to an ESPHome integration. Only the new board connects; the
   * integration's saved list is the single record of it. Idempotent on host and
   * port. The network scan calls this for every board the operator picks.
   */
  addBoardToIntegration(
    integrationId: string,
    input: AddBoardInput,
  ): Promise<{ readonly id: string; readonly name: string }> {
    return this.requireBoards().addBoard(integrationId, input)
  }

  /** Remove a board from its integration: it disconnects and its devices go. */
  removeBoardFromIntegration(integrationId: string, boardId: string): Promise<void> {
    return this.requireBoards().removeBoard(integrationId, boardId)
  }

  private async targetIntegration(named: unknown): Promise<string> {
    const mine = (await this.ctx.api.integrations.list.query()).filter(
      (i) => i.addonId === this.ctx.id,
    )
    if (typeof named === 'string') {
      if (mine.some((i) => i.id === named)) return named
      throw new Error(`'${named}' is not an ESPHome integration`)
    }
    const only = mine.length === 1 ? mine[0] : undefined
    if (only === undefined) {
      throw new Error(
        mine.length === 0
          ? 'Create an ESPHome integration first'
          : 'More than one ESPHome integration: name the one to add the board to',
      )
    }
    return only.id
  }

  // ── caps ────────────────────────────────────────────────────────────────

  private async cascadeRemoveDevicesForBroker(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: this.addonId,
      brokerId,
      logger: this.ctx.logger,
    })
  }

  /** Create the container device of a board, with its entity children. */
  private async adoptBoardContainer(input: {
    readonly brokerId: string
    readonly integrationId: string
    readonly name: string
    readonly boardName: string
  }): Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }> {
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('esphome adopt: kernel.devices unavailable')
    const { brokerId, integrationId, name, boardName } = input
    const config = { brokerId, system: 'esphome', integrationId, boardName }
    const stableId = this.generateStableId(DeviceType.Container, config)
    const device = await devices.create(stableId, EspContainerDevice, config, null, {
      type: DeviceType.Container,
      name,
      integrationId,
    })
    const children = await devices.getChildren(device.id)
    return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildEspAdoptionProvider({
      registry: this.requireRegistry(),
      logger: this.ctx.logger,
      getBoardIdsForIntegration: async (id) =>
        this.requireBoards()
          .boardsOf(id)
          .map((b) => b.id),
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
      adoptDevice: (input) => this.adoptBoardContainer(input),
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

  // ── integration → board reconcile ───────────────────────────────────────

  /** Move any single-board integration to a one-entry list, then start every board. */
  private async settleBoards(): Promise<void> {
    const boards = this.requireBoards()
    try {
      const report = await boards.migrateLegacy()
      if (report.migrated.length > 0) {
        this.ctx.logger.info('ESPHome: boards moved into their integration', {
          meta: { boardIds: [...report.migrated] },
        })
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('ESPHome board migration failed', { meta: { error: errMsg(err) } })
    }
    try {
      await boards.reconcile()
    } catch (err: unknown) {
      this.ctx.logger.warn('ESPHome integration→board reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.requireBoards()
        .reconcile()
        .catch((err: unknown) => {
          this.ctx.logger.warn('ESPHome integration→board reconcile failed', {
            meta: { error: errMsg(err) },
          })
        })
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  // ── settings / manual creation ──────────────────────────────────────────

  protected globalSettingsSchema(): ConfigUISchema {
    return buildIntegrationFormSchema()
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
    throw new Error('ESPHome devices are adopted from a connected board, not created manually')
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private setBrokerDevicesOnline(brokerId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setBrokerDevicesOnline(devices, brokerId, online)
    if (n > 0) {
      this.ctx.logger.info('ESPHome: board devices ' + (online ? 'online' : 'offline'), {
        meta: { brokerId, count: n },
      })
    }
  }

  /** Re-run the accessory reconcile of a board's container once its entity list exists. */
  private async reprobeBrokerContainers(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const containers = reg
      .getAllForAddon(this.addonId)
      .filter(
        (d): d is EspContainerDevice =>
          d instanceof EspContainerDevice && d.config.get('brokerId') === brokerId,
      )
    for (const container of containers) {
      try {
        await container.reprobe()
      } catch (err: unknown) {
        this.ctx.logger.warn('ESPHome: container reprobe failed', {
          tags: { deviceId: container.id },
          meta: { brokerId, error: errMsg(err) },
        })
      }
    }
  }

  private requireRegistry(): EspBrokerRegistry {
    if (!this.registry) throw new Error('ESPHome provider not initialised')
    return this.registry
  }

  private requireBoards(): EspIntegrationBoards {
    if (!this.integrationBoards) throw new Error('ESPHome provider not initialised')
    return this.integrationBoards
  }
}
