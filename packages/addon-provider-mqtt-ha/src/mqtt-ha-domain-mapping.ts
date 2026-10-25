import { DeviceType } from '@camstack/types'
import type { MqttHaComponent } from './mqtt-ha-discovery-types.js'

export type MqttHaCap = 'switch' | 'numeric-sensor'

export interface MqttHaEntityMapping {
  readonly deviceType: DeviceType
  readonly capabilities: readonly MqttHaCap[]
}

export function mapMqttHaComponentToCamStack(component: MqttHaComponent): MqttHaEntityMapping {
  if (component === 'switch') {
    return { deviceType: DeviceType.Switch, capabilities: ['switch'] }
  }
  return { deviceType: DeviceType.Sensor, capabilities: ['numeric-sensor'] }
}
