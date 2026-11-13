import { DeviceType } from '@camstack/types'

/**
 * Every device type this addon can persist, and therefore must be able to
 * RESTORE. A type planned by `planMqttHaDevice` but missing here is adopted
 * once and then skipped on every runner restart ("No device class registered
 * for restored type") — an IR blaster (`generic`) lost its `ir-transmitter`
 * that way.
 */
export const MQTT_HA_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Sensor,
  DeviceType.Climate,
  DeviceType.EventEmitter,
  DeviceType.Generic,
  DeviceType.Container,
]
