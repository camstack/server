import type { HmChannel, HmDataPoint, HmDevice, HmValue } from 'nodehomematic'
import type { z } from 'zod'
import type { CcuActionDeps } from './ccu-facade.js'
import { requireConfirmed, requireFacade } from './ccu-facade.js'
import type {
  CcuDeviceState,
  ChannelValues,
  DeviceDiagnostics,
  DeviceRefSchema,
  OkResultSchema,
  SetValueInputSchema,
  ValueParam,
} from './ccu-schemas.js'
import { hmName } from '../devices/hm-name.js'

type DeviceRef = z.infer<typeof DeviceRefSchema>
type SetValueInput = z.infer<typeof SetValueInputSchema>
type OkResult = z.infer<typeof OkResultSchema>

function requireDevice(devices: readonly HmDevice[], address: string): HmDevice {
  const device = devices.find((candidate) => candidate.address === address)
  if (device === undefined) throw new Error(`Device ${address} is not known to the CCU`)
  return device
}

/** The first reading of `names` on any channel (the maintenance channel carries them). */
function reading(device: HmDevice, names: readonly string[]): HmValue | undefined {
  for (const channel of device.channels) {
    const point = channel.dataPoints.find((candidate) => names.includes(candidate.parameter))
    if (point !== undefined) return point.value
  }
  return undefined
}

function numberReading(device: HmDevice, names: readonly string[]): number | null {
  const value = reading(device, names)
  return typeof value === 'number' ? value : null
}

function boolReading(device: HmDevice, names: readonly string[]): boolean | null {
  const value = reading(device, names)
  return typeof value === 'boolean' ? value : null
}

function diagnosticsOf(device: HmDevice): DeviceDiagnostics {
  const duty = reading(device, ['DUTY_CYCLE', 'DUTYCYCLE'])
  return {
    rssiDevice: numberReading(device, ['RSSI_DEVICE']),
    rssiPeer: numberReading(device, ['RSSI_PEER']),
    unreach: boolReading(device, ['UNREACH']),
    lowBattery: boolReading(device, ['LOW_BAT', 'LOWBAT']),
    dutyCycle: typeof duty === 'boolean' || typeof duty === 'number' ? duty : null,
    configPending: boolReading(device, ['CONFIG_PENDING']),
  }
}

function toValueParam(point: HmDataPoint): ValueParam {
  return {
    parameter: point.parameter,
    type: point.type,
    min: point.min ?? null,
    max: point.max ?? null,
    unit: point.unit ?? null,
    valueList: point.valueList === undefined ? null : [...point.valueList],
    writable: point.writable,
    readable: point.readable,
    value: point.value,
  }
}

function toChannelValues(channel: HmChannel): ChannelValues {
  return {
    address: channel.address,
    index: channel.index,
    type: channel.type ?? null,
    name: hmName(channel.name),
    values: channel.dataPoints.map(toValueParam),
  }
}

/**
 * The device page panel: one CCU device's VALUES and maintenance readings,
 * and a manual write of one writable value (a switch, a level, a key press).
 */
export function buildCcuDeviceStateHandlers(deps: CcuActionDeps) {
  return {
    getCcuDeviceState: async (input: DeviceRef): Promise<CcuDeviceState> => {
      const facade = requireFacade(deps, input.integrationId)
      const device = requireDevice(facade.devices(), input.address)
      return {
        address: device.address,
        name: hmName(device.name),
        type: device.type,
        firmware: {
          installed: device.firmware ?? null,
          available: device.availableFirmware ?? null,
          updatable: device.updatable ?? null,
          state: device.firmwareUpdateState ?? null,
        },
        diagnostics: diagnosticsOf(device),
        channels: device.channels.map(toChannelValues),
      }
    },

    setCcuValue: async (input: SetValueInput): Promise<OkResult> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      const device = facade
        .devices()
        .find((candidate) => candidate.channels.some((ch) => ch.address === input.channel))
      if (device === undefined) throw new Error(`Channel ${input.channel} is not known to the CCU`)
      const point = device.channels
        .find((channel) => channel.address === input.channel)
        ?.dataPoints.find((candidate) => candidate.parameter === input.parameter)
      if (point === undefined || !point.writable) {
        throw new Error(`${input.parameter} is not a writable value of ${input.channel}`)
      }
      await facade.setValue(
        { device: device.address, channel: input.channel, parameter: input.parameter },
        input.value,
      )
      deps.logger.info('Homematic: value written', {
        ...(input.deviceId === undefined ? {} : { tags: { deviceId: input.deviceId } }),
        meta: {
          integrationId: input.integrationId,
          channel: input.channel,
          parameter: input.parameter,
          value: input.value,
        },
      })
      return { ok: true }
    },
  }
}
