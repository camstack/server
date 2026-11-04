/**
 * The device-settings form keys of the Alexa export. The device form flattens its fields by
 * `key` across every exporter and every skill, so a key that belongs to ONE skill carries the
 * skill's id: `alexa:<instanceId>:<deviceId>:<field>`.
 */
export type DeviceSettingField = 'enabled' | 'streamPreference' | 'allowTranscode'

export function deviceSettingKey(
  instanceId: string,
  deviceId: number,
  field: DeviceSettingField,
): string {
  return `alexa:${instanceId}:${deviceId}:${field}`
}

const DEVICE_SETTING_KEY = /^alexa:([^:]+):(\d+):(enabled|streamPreference|allowTranscode)$/

/** Whether `key` is a per-skill key of `instanceId`'s section for `deviceId`. */
export function isDeviceSettingKeyOf(key: string, instanceId: string, deviceId: number): boolean {
  const match = DEVICE_SETTING_KEY.exec(key)
  return match !== null && match[1] === instanceId && Number(match[2]) === deviceId
}
