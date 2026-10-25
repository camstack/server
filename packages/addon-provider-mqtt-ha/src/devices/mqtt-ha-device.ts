import { z } from 'zod'
import {
  BaseDevice,
  switchCapability,
  numericSensorCapability,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  type NumericSensorStatus,
  type SwitchStatus,
} from '@camstack/types'
import type { MqttHaCap } from '../mqtt-ha-domain-mapping.js'
import { mqttHaStateGateway } from '../mqtt-ha-state-gateway.js'
import type { MqttHaDiscoveryStore } from '../mqtt-ha-discovery-store.js'

export const mqttHaDeviceSchema = z.object({
  entityKey: z.string().min(1),
  brokerId: z.string().min(1),
  component: z.enum(['sensor', 'switch']),
  stateTopic: z.string().min(1),
  commandTopic: z.string().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  unitOfMeasurement: z.string().nullable().optional(),
  payloadOn: z.string().default('ON'),
  payloadOff: z.string().default('OFF'),
  system: z.literal('mqtt-ha').optional(),
  integrationId: z.string().optional(),
})

export type MqttHaDeviceConfig = z.infer<typeof mqttHaDeviceSchema>

const KNOWN_CAPS: ReadonlySet<MqttHaCap> = new Set(['switch', 'numeric-sensor'])

function isKnownCap(value: string): value is MqttHaCap {
  return KNOWN_CAPS.has(value as MqttHaCap)
}

/**
 * One imported MQTT HA discovery entity as a flat CamStack device (sensor or switch).
 */
export class MqttHaDevice extends BaseDevice<typeof mqttHaDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly entityKey: string
  private readonly brokerId: string
  private readonly caps: readonly MqttHaCap[]
  private readonly unitOfMeasurement: string | null

  constructor(ctx: DeviceContext) {
    const persisted = mqttHaDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, mqttHaDeviceSchema, { type: ctx.deviceMeta.type })
    this.entityKey = persisted.entityKey
    this.brokerId = persisted.brokerId
    this.caps = persisted.capabilities.filter(isKnownCap)
    this.unitOfMeasurement = persisted.unitOfMeasurement ?? null
    this.online = true
    void this.updateSourceInfo({ id: this.entityKey, system: 'mqtt-ha' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    for (const cap of this.caps) {
      if (cap === 'switch') this.registerSwitch()
      if (cap === 'numeric-sensor') this.registerNumericSensor()
    }
  }

  private registerSwitch(): void {
    const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => {
        const live = mqttHaStateGateway.getSwitchState(this.brokerId, this.entityKey)
        return live ?? this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD
      },
      setState: async ({ on }) => {
        const entity = resolveEntity(this.brokerId, this.entityKey)
        await mqttHaStateGateway.publishSwitchCommand(entity, on)
        this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD)
  }

  private registerNumericSensor(): void {
    const COLD: NumericSensorStatus = {
      value: 0,
      lastFetchedAt: 0,
      ...(this.unitOfMeasurement !== null ? { unit: this.unitOfMeasurement } : {}),
    }
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () => {
        const live = mqttHaStateGateway.getSensorState(this.brokerId, this.entityKey)
        if (live === null) {
          return this.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor') ?? COLD
        }
        return {
          value: live.value,
          lastFetchedAt: live.lastFetchedAt,
          ...(this.unitOfMeasurement !== null ? { unit: this.unitOfMeasurement } : {}),
        }
      },
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    this.runtimeState.setCapState('numeric-sensor', COLD)
  }
}

/** Resolve discovery metadata for outbound MQTT commands (injected at adopt time). */
let discoveryStoreRef: MqttHaDiscoveryStore | null = null

export function wireMqttHaDiscoveryStore(store: MqttHaDiscoveryStore): void {
  discoveryStoreRef = store
}

function resolveEntity(brokerId: string, entityKey: string) {
  const store = discoveryStoreRef
  if (store === null) throw new Error('mqtt-ha: discovery store not wired')
  const entity = store.get(brokerId, entityKey)
  if (entity === null) throw new Error(`mqtt-ha: entity ${entityKey} not in discovery store`)
  return entity
}
