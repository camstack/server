import type { HmChannel, HmCustomEntity, HmDataPoint, HmDevice, HmValue } from 'nodehomematic'

interface DataPointSeed {
  readonly parameter: string
  readonly type?: string
  readonly value?: HmValue
  readonly unit?: string
}

export function hmDataPoint(seed: DataPointSeed): HmDataPoint {
  return {
    id: `dp:${seed.parameter.toLowerCase()}`,
    parameter: seed.parameter,
    type: seed.type ?? 'FLOAT',
    value: seed.value ?? null,
    unit: seed.unit,
    readable: true,
    writable: false,
    hasEvents: true,
  }
}

export interface HmChannelSeed {
  readonly address: string
  readonly index: number
  readonly type: string
  readonly dataPoints?: readonly HmDataPoint[]
  /** Facade-only name field (nodehomematic 0.6); omitted from the exported channel type. */
  readonly name?: string
}

export function hmChannel(seed: HmChannelSeed): HmChannel {
  const channel: HmChannel = {
    address: seed.address,
    index: seed.index,
    type: seed.type,
    dataPoints: seed.dataPoints ? [...seed.dataPoints] : [],
  }
  if (seed.name === undefined) return channel
  return Object.assign(channel, { name: seed.name })
}

export interface HmDeviceSeed {
  readonly address: string
  readonly type: string
  readonly name?: string
  readonly channels: readonly HmChannelSeed[]
  readonly firmware?: string
  readonly availableFirmware?: string
  readonly updatable?: boolean
  readonly firmwareUpdateState?: string
}

/** Fully-typed {@link HmDevice} for unit tests — no cast at call sites. */
export function hmDevice(seed: HmDeviceSeed): HmDevice {
  return {
    address: seed.address,
    type: seed.type,
    name: seed.name,
    firmware: seed.firmware,
    availableFirmware: seed.availableFirmware,
    updatable: seed.updatable,
    firmwareUpdateState: seed.firmwareUpdateState,
    channels: seed.channels.map(hmChannel),
  }
}

export interface HmSwitchEntitySeed {
  readonly device: string
  readonly channel: string
  readonly isOn?: boolean
}

export function hmSwitchEntity(seed: HmSwitchEntitySeed): HmCustomEntity {
  return {
    kind: 'switch',
    device: seed.device,
    channel: seed.channel,
    isOn: seed.isOn ?? false,
  }
}

export interface HmClimateEntitySeed {
  readonly device: string
  readonly channel: string
}

export function hmClimateEntity(seed: HmClimateEntitySeed): HmCustomEntity {
  return {
    kind: 'climate',
    device: seed.device,
    channel: seed.channel,
    currentTemperature: null,
    targetTemperature: null,
    currentHumidity: null,
    minTemp: 5,
    maxTemp: 30,
    targetTemperatureStep: 0.5,
    mode: 'auto',
    preset: 'none',
    activity: 'idle',
  }
}
