/**
 * Zigbee2MQTT — a device integration (role `devices`, D996). An integration is one typed
 * connection record (secret + test) served through `integration-instances`; the devices it brings
 * are adopted from it and carry its `integrationId`. There is no addon-level settings page and no
 * legacy settings row: if the operator can configure it, it is an instance.
 *
 * Deleting a device is learned through `device-removal-hook` (a tombstone, D865), never from the
 * device missing from a list. A failed read of the remote changes nothing (D49).
 */
import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceRole,
  DeviceType,
  deviceAdoptionCapability,
  deviceRemovalHookCapability,
  errMsg,
  EventCategory,
  type IDevice,
  type InitialDeviceMeta,
  type IntegrationTestConnectionResult,
  integrationInstancesCapability,
  type RecordIntegrationInstances,
  type SystemEvent,
} from '@camstack/types'
import {
  buildProviderZigbeeZ2mAdoptionProvider,
  type RemoteZigbeeDevice,
} from './provider-zigbee-z2m-adoption.js'
import {
  buildProviderZigbeeZ2mInstances,
  ProviderZigbeeZ2mRecordKinds,
  Z2M_DEFAULT_PORT,
  type ProviderZigbeeZ2mConnectionBody,
} from './provider-zigbee-z2m-instances.js'
import { type Z2mConnection, type Z2mEndpoint } from './z2m-client.js'
import { Z2M_SYSTEM } from './z2m-device-config.js'
import { ZigbeeDevice } from './z2m-device.js'
import { planZ2mDevice, roleForPrimaryCap, type Z2mPlan } from './z2m-exposes.js'
import { ZigbeeGatewayDevice } from './z2m-gateway-device.js'
import { Z2mManagement, type ZigbeeZ2mActions, zigbeeZ2mActions } from './z2m-actions.js'
import { z2mHub } from './z2m-hub.js'
import { probeZ2m } from './z2m-probe.js'
import { Z2mSessionFault, z2mSessionHealth } from './z2m-session-health.js'

/** The endpoint an instance record describes, or null while it names no host. */
export function endpointOf(body: ProviderZigbeeZ2mConnectionBody): Z2mEndpoint | null {
  const host = (body.host ?? '').trim()
  if (host.length === 0) return null
  const token = body.token ?? ''
  return {
    host,
    port: body.port ?? Z2M_DEFAULT_PORT,
    tls: body.tls === true,
    token: token.length > 0 ? token : null,
  }
}

/** Every device type a Zigbee2MQTT device can be adopted as; each restores through the same class. */
const ZIGBEE_TYPES = [
  DeviceType.Sensor,
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Cover,
  DeviceType.Lock,
  DeviceType.Climate,
  DeviceType.EventEmitter,
] as const

export class ProviderZigbeeZ2mAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-zigbee-z2m'
  protected readonly providerName = 'Zigbee2MQTT'
  // The Gateway and the devices are siblings: all are restored as top-level devices.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: ZigbeeGatewayDevice,
    ...Object.fromEntries(ZIGBEE_TYPES.map((type) => [type, ZigbeeDevice])),
  }

  private instances: RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody> | null = null
  private readonly healthSubs = new Map<string, () => void>()
  private readonly endpoints = new Map<string, string>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<ZigbeeZ2mActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-zigbee-z2m: ctx.records is required (hub-only addon)')
    }
    await records.declare(ProviderZigbeeZ2mRecordKinds)
    const instances = buildProviderZigbeeZ2mInstances(records, {
      onChanged: () => this.reconcile(),
      probe: (values) => this.probe(values),
    })
    this.instances = instances
    z2mSessionHealth.bind({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
    })
    this.ctx.eventBus.subscribe(
      { category: EventCategory.IntegrationDeleted },
      (event: SystemEvent) => {
        const addonId = event.data['addonId']
        if (typeof addonId === 'string' && addonId !== this.ctx.id) return
        void this.reconcile()
      },
    )
    void this.reconcile()
    const management = new Z2mManagement(z2mHub, this.ctx.logger)
    return {
      providers: [
        ...regs,
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(instances),
        },
        {
          capability: integrationInstancesCapability,
          provider: instances.toProvider(),
        },
        {
          capability: deviceRemovalHookCapability,
          // Device DATA only (footage, history, rows). Settings are cleared centrally. Idempotent.
          provider: {
            onDeviceRemoved: async () => ({ counts: {} }),
            listDeviceData: async () => [],
          },
        },
      ],
      customActions: zigbeeZ2mActions,
      actionHandlers: {
        permitJoin: async (input) => management.permitJoin(input),
        renameDevice: async (input) => management.renameDevice(input),
        removeDevice: async (input) => management.removeDevice(input),
        restartBridge: async (input) => management.restartBridge(input),
        checkDeviceUpdate: async (input) => management.checkDeviceUpdate(input),
        updateDevice: async (input) => management.updateDevice(input),
        deviceUpdates: async (input) => management.deviceUpdates(input),
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    for (const unsub of this.healthSubs.values()) unsub()
    this.healthSubs.clear()
    this.endpoints.clear()
    z2mHub.disconnectAll()
    z2mSessionHealth.unbind()
    this.instances = null
    await super.onShutdown()
  }

  /**
   * Make the open connections match the records: one per enabled integration with a host, replaced
   * when its endpoint changed, closed when it vanished. A failed read of the records changes nothing (D49).
   */
  private async reconcile(): Promise<void> {
    const instances = this.instances
    if (instances === null) return
    try {
      const all = await instances.listResolved()
      const wanted = new Set<string>()
      for (const read of all) {
        const endpoint = read.enabled ? endpointOf(read.body) : null
        if (endpoint === null) continue
        wanted.add(read.id)
        z2mSessionHealth.register(read.id, read.body.name)
        const fingerprint = JSON.stringify(endpoint)
        // A locked keychain yields the row without its token: keep the open link rather than reconnect without it.
        if (read.secrets !== 'resolved' && z2mHub.session(read.id) !== null) continue
        if (this.endpoints.get(read.id) === fingerprint && z2mHub.session(read.id) !== null)
          continue
        this.open(read.id, endpoint)
        this.endpoints.set(read.id, fingerprint)
      }
      for (const id of [...this.endpoints.keys()]) {
        if (wanted.has(id)) continue
        this.close(id)
        await z2mSessionHealth.forget(id)
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('zigbee2mqtt: integrations reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private open(integrationId: string, endpoint: Z2mEndpoint): void {
    this.healthSubs.get(integrationId)?.()
    const session = z2mHub.connect(integrationId, endpoint, this.ctx.logger)
    this.healthSubs.set(
      integrationId,
      z2mHub.subscribeLink(integrationId, {
        connection: (state) => this.reportConnection(integrationId, state),
        bridge: () => {},
        devices: () => {},
      }),
    )
    session.start()
  }

  private close(integrationId: string): void {
    this.healthSubs.get(integrationId)?.()
    this.healthSubs.delete(integrationId)
    this.endpoints.delete(integrationId)
    z2mHub.disconnect(integrationId)
  }

  private reportConnection(integrationId: string, state: Z2mConnection): void {
    if (state === 'online') {
      void z2mSessionHealth.ok(integrationId)
    } else if (state === 'auth-rejected') {
      z2mSessionHealth.failure(
        integrationId,
        new Z2mSessionFault('auth-rejected', 'The server refused the auth token'),
      )
    } else if (state === 'offline') {
      z2mSessionHealth.failure(
        integrationId,
        new Z2mSessionFault('connection-lost', 'The server is unreachable'),
      )
    }
  }

  /** A definite refusal is `rejected`; "could not tell" is `inconclusive`. */
  private async probe(
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const host = values['host']
    if (typeof host !== 'string' || host.trim().length === 0) {
      return { success: false, status: 'rejected', error: 'Host is required' }
    }
    const port = values['port']
    const token = values['token']
    return probeZ2m({
      host: host.trim(),
      port: typeof port === 'number' && port > 0 ? port : Z2M_DEFAULT_PORT,
      tls: values['tls'] === true,
      token: typeof token === 'string' && token.length > 0 ? token : null,
    })
  }

  private buildAdoptionProvider(
    instances: RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody>,
  ) {
    return buildProviderZigbeeZ2mAdoptionProvider({
      hasIntegration: async (integrationId) =>
        (await instances.readResolved(integrationId)) !== null,
      listIntegrations: async () => (await instances.listResolved()).map((read) => read.id),
      discover: async (integrationId) => {
        const session = z2mHub.session(integrationId)
        if (session === null || session.connection !== 'online') return null
        const found: RemoteZigbeeDevice[] = []
        for (const device of session.deviceTable().values()) {
          if (device.type === 'Coordinator') continue
          const exposes = device.definition?.exposes
          if (exposes === undefined) continue
          const plan = planZ2mDevice(exposes)
          if (plan === null) continue
          found.push({
            id: device.ieee_address,
            name: device.friendly_name,
            type: plan.deviceType,
            online: session.availabilityOf(device.ieee_address),
            plan,
          })
        }
        return found
      },
      adopted: async (integrationId) => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        const out = new Map<string, number>()
        if (!reg || !devices) return out
        for (const d of reg.getAllForAddon(this.addonId)) {
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          if (config['integrationId'] !== integrationId) continue
          const equipment = config['equipment']
          if (typeof equipment === 'string') out.set(equipment, d.id)
        }
        return out
      },
      create: async ({ integrationId, equipment, type, name, plan }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('provider-zigbee-z2m adopt: kernel.devices unavailable')
        const config = {
          equipment,
          integrationId,
          system: Z2M_SYSTEM,
          ...(plan !== null ? { plan } : {}),
        }
        const stableId = this.generateStableId(type, config)
        const meta = initialMeta(type, name, integrationId, plan)
        const device =
          type === DeviceType.Gateway
            ? await devices.create(stableId, ZigbeeGatewayDevice, config, null, meta)
            : await devices.create(stableId, ZigbeeDevice, config, null, meta)
        this.ctx.logger.info('zigbee2mqtt: device adopted', {
          tags: { deviceId: device.id },
          meta: {
            stableId,
            type,
            capabilities: plan?.capabilities.join(',') ?? '',
          },
        })
        return device.id
      },
      remove: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      logger: this.ctx.logger,
    })
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const equipment = config?.['equipment']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('provider-zigbee-z2m generateStableId: integrationId required')
    }
    if (typeof equipment !== 'string' || equipment.length === 0) {
      throw new Error('provider-zigbee-z2m generateStableId: equipment required')
    }
    return 'provider-zigbee-z2m:' + integrationId + ':' + equipment
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
    throw new Error('Zigbee2MQTT devices are adopted from the integration')
  }
}

/** The meta row of an adopted device: its type and name, plus the role its primary function names. */
export function initialMeta(
  type: DeviceType,
  name: string,
  integrationId: string,
  plan: Z2mPlan | null,
): InitialDeviceMeta {
  const role: DeviceRole | null = roleForPrimaryCap(plan?.capabilities[0])
  return { type, name, integrationId, ...(role !== null ? { role } : {}) }
}

export default ProviderZigbeeZ2mAddon
