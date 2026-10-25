/** Summary of one SHC device after discovery normalisation. */
export interface ShcDeviceSummary {
  readonly id: string
  readonly deviceModel: string
  readonly name: string
  readonly services: readonly string[]
  readonly roomId?: string
  readonly childDeviceIds?: readonly string[]
  readonly parentDeviceId?: string
}

/** Raw device row from GET /devices (subset). */
export interface ShcRawDevice {
  readonly id?: string
  readonly deviceModel?: string
  readonly name?: string
  readonly roomId?: string
  readonly childDeviceIds?: readonly string[]
  readonly parentDeviceId?: string
  readonly deviceServiceData?: readonly ShcRawServiceRef[]
  readonly deviceServiceIds?: readonly string[]
}

export interface ShcRoomSummary {
  readonly id: string
  readonly name: string
}

export interface ShcRawServiceRef {
  readonly id?: string
  readonly serviceType?: string
}

/** RoomClimateControl GET state (subset). */
export interface ShcRoomClimateState {
  readonly '@type'?: string
  /** Legacy tests. The controller sends `operationMode`. */
  readonly mode?: string
  readonly operationMode?: string
  /** `HEATING` or `OFF`. Independent of `operationMode`. */
  readonly roomControlMode?: string
  readonly setpointTemperature?: number
  readonly temperature?: number
  readonly minTemperature?: number
  readonly maxTemperature?: number
}

/** PowerSwitch GET state (subset). */
export interface ShcPowerSwitchState {
  readonly '@type'?: string
  /** Controller sends `"ON"` / `"OFF"`. A boolean is accepted from older fakes. */
  readonly switchState?: boolean | string
  readonly switchStates?: readonly { readonly switchState?: boolean | string }[]
}

/** TRV TemperatureLevel state (subset). */
export interface ShcTemperatureLevelState {
  readonly '@type'?: string
  readonly temperature?: number
}

/** TRV ValveTappet state (subset). */
export interface ShcValveTappetState {
  readonly '@type'?: string
  readonly position?: number
}

/** TRV BatteryLevel state (subset). */
export interface ShcBatteryLevelState {
  readonly '@type'?: string
  readonly batteryLevel?: number
}

/** Long-poll event notification (subset). */
export interface ShcEventNotification {
  readonly deviceId?: string
  readonly serviceId?: string
  readonly eventType?: string
}

export type ShcDeviceKind = 'room-climate' | 'switch' | 'trv' | 'unsupported'
