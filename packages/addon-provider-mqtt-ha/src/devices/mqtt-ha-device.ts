import { z } from 'zod'
import {
  BaseDevice,
  switchCapability,
  numericSensorCapability,
  ingestReading,
  quantityFromUnit,
  type DeviceContext,
  type ReadingQuantity,
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
  /** Null when the discovery unit is not a known quantity — samples stay null. */
  private readonly readingQuantity: ReadingQuantity | null

  constructor(ctx: DeviceContext) {
    const persisted = mqttHaDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, mqttHaDeviceSchema, { type: ctx.deviceMeta.type })
    this.entityKey = persisted.entityKey
    this.brokerId = persisted.brokerId
    this.caps = persisted.capabilities.filter(isKnownCap)
    this.unitOfMeasurement = persisted.unitOfMeasurement ?? null
    this.readingQuantity = learnQuantity(this.unitOfMeasurement)
    this.online = true
    if (this.unitOfMeasurement !== null && this.readingQuantity === null) {
      this.ctx.logger.warn('numeric reading refused', {
        tags: { deviceId: this.id },
        meta: { quantity: 'device', unit: this.unitOfMeasurement, reason: 'unknown-unit' },
      })
    }
    void this.updateSourceInfo({
      id: this.entityKey,
      system: 'mqtt-ha',
      ...(this.readingQuantity !== null ? { quantity: this.readingQuantity } : {}),
    })
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
    const COLD: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () => {
        const live = mqttHaStateGateway.getSensorState(this.brokerId, this.entityKey)
        if (live === null) {
          return this.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor') ?? COLD
        }
        return { value: this.toBase(live.value), lastFetchedAt: live.lastFetchedAt }
      },
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    this.runtimeState.setCapState('numeric-sensor', COLD)
  }

  private toBase(value: number): number | null {
    if (this.readingQuantity === null) return null
    const rawUnit = this.unitOfMeasurement ?? undefined
    const result = ingestReading({ value, rawUnit, quantity: this.readingQuantity })
    if (result.ok) return result.value
    this.ctx.logger.warn('numeric reading refused', {
      tags: { deviceId: this.id },
      meta: { quantity: this.readingQuantity, unit: rawUnit ?? '', reason: result.reason },
    })
    return null
  }
}

function learnQuantity(unit: string | null): ReadingQuantity | null {
  if (unit === null) return 'none'
  const learned = quantityFromUnit(unit)
  if (learned === undefined || learned === 'device') return null
  return learned
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
