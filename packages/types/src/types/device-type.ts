/**
 * @deprecated Use DeviceType from '@camstack/types/device' instead.
 * This file is kept for backwards compatibility during migration.
 */

/* eslint-disable @typescript-eslint/no-deprecated */

export enum DeviceType {
  Camera = 'camera',
}

export interface DeviceTypeInfo {
  readonly type: DeviceType
  readonly label: string
  readonly icon: string // lucide icon name
}

export const DEVICE_TYPE_INFO: Record<DeviceType, DeviceTypeInfo> = {
  [DeviceType.Camera]: { type: DeviceType.Camera, label: 'Camera', icon: 'camera' },
}
