import {
  BaseDeviceProvider,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { buildMqttHaAdoptionProvider } from './mqtt-ha-adoption-provider.js'
import { buildMqttHaDeviceStableId, buildMqttHaStableId } from './mqtt-ha-discovery-parser.js'
import { MqttHaDiscoveryStore } from './mqtt-ha-discovery-store.js'
import {
  MqttHaBrokerSessionManager,
  type BrokerConnectionDetails,
} from './mqtt-ha-broker-session.js'
import { mqttHaStateGateway } from './mqtt-ha-state-gateway.js'
import { MqttHaDevice } from './devices/mqtt-ha-device.js'
import { MqttHaContainerDevice } from './devices/mqtt-ha-container-device.js'
import type { MqttHaDevicePlan } from './mqtt-ha-domain-mapping.js'

type MqttHaProviderConfig = Record<string, never>

/**
 * `mqtt-broker` is a collection cap: an unpinned call is answered by the
 * first-registered provider, which returns null for a broker it does not own.
 * The brokers this addon connects to are the MQTT Broker addon's.
 */
const MQTT_BROKER_ADDON_ID = 'mqtt-broker'

const MQTT_HA_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Sensor,
  DeviceType.Thermostat,
  DeviceType.EventEmitter,
  DeviceType.Container,
]

/**
 * MQTT Home Assistant discovery IMPORT addon. Subscribes to
 * `homeassistant/+/+/config` on a broker from the `mqtt-broker` cap and adopts
 * one device per physical device (zigbee2mqtt included) via `device-adoption`.
 */
export class MqttHaProviderAddon extends BaseDeviceProvider<MqttHaProviderConfig> {
  protected readonly addonId = 'provider-mqtt-ha'
  protected readonly providerName = 'MQTT HA Discovery Import'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> =
    Object.fromEntries(
      MQTT_HA_DEVICE_TYPES.map((t) => [
        t,
        t === DeviceType.Container ? MqttHaContainerDevice : MqttHaDevice,
      ]),
    )

  private readonly discoveryStore = new MqttHaDiscoveryStore()
  private sessionManager: MqttHaBrokerSessionManager | null = null
  /** integrationId → mqtt broker registry id */
  private readonly integrationToMqttBroker = new Map<string, string>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.sessionManager = new MqttHaBrokerSessionManager({
      addonId: this.ctx.id,
      store: this.discoveryStore,
      stateGateway: mqttHaStateGateway,
      logger: this.ctx.logger,
      getConnection: (brokerId: string) => this.fetchMqttBrokerConfig(brokerId),
    })

    mqttHaStateGateway.setPublisher(async ({ brokerId, topic, payload }) => {
      const session = this.requireSessionManager().getSession(brokerId)
      if (session === null) throw new Error(`mqtt-ha: no active session for broker ${brokerId}`)
      await session.publish(topic, payload)
    })

    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('mqtt-ha: provider initialised', {
      meta: { linkedIntegrations: this.integrationToMqttBroker.size },
    })

    return [
      ...regs,
      {
        capability: deviceAdoptionCapability,
        provider: this.buildAdoptionProvider(),
      },
    ]
  }

  protected override async onShutdown(): Promise<void> {
    await this.sessionManager?.shutdownAll()
    this.sessionManager = null
    await super.onShutdown()
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'mqtt-ha-broker-link',
          title: 'MQTT broker',
          titleKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.title',
          description:
            'Each integration instance links to an MQTT broker (Connectivity → MQTT brokers).',
          descriptionKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.description',
          columns: 1,
          fields: [
            {
              type: 'info',
              key: 'help',
              label: 'Broker link',
              labelKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.help.label',
              content: 'Entities appear under Integrations → Adopt once discovery messages arrive.',
            },
          ],
        },
      ],
    })
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('mqtt-ha: devices are created via device-adoption only')
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = typeof config?.['brokerId'] === 'string' ? config['brokerId'] : null
    const entityKey = typeof config?.['entityKey'] === 'string' ? config['entityKey'] : null
    const deviceKey = typeof config?.['deviceKey'] === 'string' ? config['deviceKey'] : null
    if (brokerId === null || entityKey === null) {
      throw new Error('mqtt-ha: stable id requires brokerId and entityKey')
    }
    return deviceKey !== null
      ? buildMqttHaDeviceStableId(brokerId, deviceKey)
      : buildMqttHaStableId(brokerId, entityKey)
  }

  private requireSessionManager(): MqttHaBrokerSessionManager {
    if (this.sessionManager === null) throw new Error('mqtt-ha: not initialised')
    return this.sessionManager
  }

  private async fetchMqttBrokerConfig(brokerId: string): Promise<BrokerConnectionDetails | null> {
    try {
      const cfg = await this.ctx.api.mqttBroker.getBrokerConfig.query({
        id: brokerId,
        addonId: MQTT_BROKER_ADDON_ID,
      })
      return {
        url: cfg.url,
        ...(cfg.username !== undefined ? { username: cfg.username } : {}),
        ...(cfg.password !== undefined ? { password: cfg.password } : {}),
        ...(cfg.clientIdPrefix !== undefined ? { clientIdPrefix: cfg.clientIdPrefix } : {}),
      }
    } catch (err) {
      this.ctx.logger.warn('mqtt-ha: getBrokerConfig failed', {
        meta: { brokerId, error: errMsg(err) },
      })
      return null
    }
  }

  private async reconcileIntegrationsToBrokers(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id)
      this.integrationToMqttBroker.clear()

      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
        const mqttBrokerId =
          typeof settings['mqttBrokerId'] === 'string'
            ? settings['mqttBrokerId']
            : typeof settings['brokerId'] === 'string'
              ? settings['brokerId']
              : undefined
        if (mqttBrokerId === undefined) continue
        this.integrationToMqttBroker.set(integration.id, mqttBrokerId)
        await this.requireSessionManager().ensureSession(mqttBrokerId)
      }
    } catch (err) {
      this.ctx.logger.warn('mqtt-ha: integration→broker reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrationsToBrokers()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  /**
   * Create one plain device from a plan. A gang child (or a lone entity) has no
   * `deviceKey`, so its stable id is the entity form a lone entity always had.
   */
  private async adoptPlan(input: {
    readonly brokerId: string
    readonly integrationId: string
    readonly name: string
    readonly plan: MqttHaDevicePlan
    readonly deviceKey: string | null
    readonly parentDeviceId: number | null
  }): Promise<{ readonly deviceId: number }> {
    const { plan } = input
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('mqtt-ha adopt: kernel.devices unavailable')
    const first = plan.members[0]
    if (first === undefined) throw new Error(`mqtt-ha adopt: ${input.name} has no members`)
    const config = {
      brokerId: input.brokerId,
      entityKey: first.entityKey,
      ...(input.deviceKey !== null ? { deviceKey: input.deviceKey } : {}),
      entities: [...plan.members],
      bindings: plan.bindings,
      meter: plan.meter,
      capabilities: [...plan.capabilities],
      system: 'mqtt-ha',
      integrationId: input.integrationId,
      name: input.name,
    }
    const stableId = this.generateStableId(plan.deviceType, config)
    const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
    if (existing) return { deviceId: existing.id }
    const created = await devices.create(stableId, MqttHaDevice, config, input.parentDeviceId, {
      type: plan.deviceType,
      name: input.name,
      integrationId: input.integrationId,
    })
    this.ctx.logger.info('mqtt-ha: device adopted', {
      tags: { deviceId: created.id },
      meta: {
        stableId,
        type: plan.deviceType,
        capabilities: plan.capabilities.join(','),
        skippedEntities: plan.skipped.join(','),
      },
    })
    return { deviceId: created.id }
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildMqttHaAdoptionProvider({
      store: this.discoveryStore,
      logger: this.ctx.logger,
      getMqttBrokerIdForIntegration: async (integrationId) => {
        const fromMap = this.integrationToMqttBroker.get(integrationId)
        if (fromMap !== undefined) return fromMap
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integrationId })
        const mqttBrokerId =
          typeof settings['mqttBrokerId'] === 'string'
            ? settings['mqttBrokerId']
            : typeof settings['brokerId'] === 'string'
              ? settings['brokerId']
              : undefined
        if (mqttBrokerId === undefined) {
          throw new Error(`integration ${integrationId} has no mqttBrokerId`)
        }
        return mqttBrokerId
      },
      listAdoptedMqttHa: async () => {
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
      adoptDevice: async ({ brokerId, adoptable, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('mqtt-ha adopt: kernel.devices unavailable')
        const { device: physical } = adoptable
        if (adoptable.kind === 'single') {
          return this.adoptPlan({
            brokerId,
            integrationId,
            name,
            plan: adoptable.plan,
            deviceKey: physical.kind === 'device' ? physical.nativeId : null,
            parentDeviceId: null,
          })
        }
        const containerConfig = {
          brokerId,
          entityKey: adoptable.container.gangs[0]?.nativeId ?? physical.nativeId,
          deviceKey: physical.nativeId,
          system: 'mqtt-ha',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, containerConfig)
        const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
        const container =
          existing ??
          (await devices.create(stableId, MqttHaContainerDevice, containerConfig, null, {
            type: DeviceType.Container,
            name,
            integrationId,
          }))
        for (const gang of adoptable.container.gangs) {
          await this.adoptPlan({
            brokerId,
            integrationId,
            name: gang.name,
            plan: gang.plan,
            deviceKey: null,
            parentDeviceId: container.id,
          })
        }
        return { deviceId: container.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
    })
  }
}
