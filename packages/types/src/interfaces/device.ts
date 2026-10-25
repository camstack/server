/**
 * Shared device types used by API responses and capability interfaces.
 * The legacy ILegacyDevice interface has been removed — use IDevice from '@camstack/types/device'.
 */

export interface DeviceState {
  online: boolean
  lastSeen?: number
  error?: string
}

export interface DeviceMetadata {
  manufacturer?: string
  model?: string
  firmware?: string
  hardwareId?: string
  ip?: string
}

export interface DeviceEvent {
  deviceId: string
  type: string
  timestamp: number
  data: Record<string, unknown>
}
