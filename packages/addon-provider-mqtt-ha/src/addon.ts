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
import { buildMqttHaStableId } from './mqtt-ha-discovery-parser.js'
import { MqttHaDiscoveryStore } from './mqtt-ha-discovery-store.js'
import { mapMqttHaComponentToCamStack } from './mqtt-ha-domain-mapping.js'
import {
  MqttHaBrokerSessionManager,
  type BrokerConnectionDetails,
} from './mqtt-ha-broker-session.js'
import { mqttHaStateGateway } from './mqtt-ha-state-gateway.js'
import { MqttHaDevice, wireMqttHaDiscoveryStore } from './devices/mqtt-ha-device.js'

type MqttHaProviderConfig = Record<string, never>

/**
 * `mqtt-broker` is a collection cap: an unpinned call is answered by the
 * first-registered provider, which returns null for a broker it does not own.
 * The brokers this addon connects to are the MQTT Broker addon's.
 */
const MQTT_BROKER_ADDON_ID = 'mqtt-broker'

const MQTT_HA_DEVICE_TYPES: readonly DeviceType[] = [DeviceType.Switch, DeviceType.Sensor]

/**
 * MQTT Home Assistant discovery IMPORT addon. Subscribes to
 * `homeassistant/+/+/config` on a broker from the `mqtt-broker` cap and adopts
 * v1 `sensor` + `switch` entities via `device-adoption`.
 */
export class MqttHaProviderAddon extends BaseDeviceProvider<MqttHaProviderConfig> {
  protected readonly addonId = 'provider-mqtt-ha'
  protected readonly providerName = 'MQTT HA Discovery Import'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> =
    Object.fromEntries(MQTT_HA_DEVICE_TYPES.map((t) => [t, MqttHaDevice]))

  private readonly discoveryStore = new MqttHaDiscoveryStore()
  private sessionManager: MqttHaBrokerSessionManager | null = null
  /** integrationId → mqtt broker registry id */
  private readonly integrationToMqttBroker = new Map<string, string>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    wireMqttHaDiscoveryStore(this.discoveryStore)

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
    if (brokerId === null || entityKey === null) {
      throw new Error('mqtt-ha: stable id requires brokerId and entityKey')
    }
    return buildMqttHaStableId(brokerId, entityKey)
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
      adoptEntity: async ({ brokerId, entityKey, integrationId, name }) => {
        const entity = this.discoveryStore.get(brokerId, entityKey)
        if (entity === null) throw new Error(`mqtt-ha adopt: unknown entity ${entityKey}`)
        const mapping = mapMqttHaComponentToCamStack(entity.component)
        const config = {
          entityKey,
          brokerId,
          component: entity.component,
          stateTopic: entity.stateTopic,
          commandTopic: entity.commandTopic,
          capabilities: [...mapping.capabilities],
          unitOfMeasurement: entity.unitOfMeasurement,
          payloadOn: entity.payloadOn,
          payloadOff: entity.payloadOff,
          system: 'mqtt-ha',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(mapping.deviceType, config)
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('mqtt-ha adopt: kernel.devices unavailable')

        const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
        if (existing) return { deviceId: existing.id }

        const device = await devices.create(stableId, MqttHaDevice, config, null, {
          type: mapping.deviceType,
          name,
          integrationId,
        })
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
    })
  }
}
