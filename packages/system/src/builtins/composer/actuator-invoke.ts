/**
 * Turn one fan-out call into the member's existing cap method. A bad argument
 * fails that member only — the caller still attempts the rest. Only the
 * methods of the method tables (`ACTUATOR_METHODS`) have a fan-out here.
 */
import {
  type ColorInput,
  type FanDirection,
  FanDirectionSchema,
  type FanOutCall,
  type HvacMode,
  HvacModeSchema,
  parseColorInput,
} from '@camstack/types'

export interface ActuatorInvokeApi {
  switchSetState(deviceId: number, on: boolean): Promise<void>
  setBrightness(deviceId: number, percentage: number): Promise<void>
  setColor(deviceId: number, color: ColorInput): Promise<void>
  fanSetPercentage(deviceId: number, percentage: number): Promise<void>
  fanSetPreset(deviceId: number, preset: string): Promise<void>
  fanSetDirection(deviceId: number, direction: FanDirection): Promise<void>
  fanSetOscillating(deviceId: number, oscillating: boolean): Promise<void>
  coverOpen(deviceId: number): Promise<void>
  coverClose(deviceId: number): Promise<void>
  coverStop(deviceId: number): Promise<void>
  coverSetPosition(deviceId: number, position: number): Promise<void>
  coverSetTiltPosition(deviceId: number, tiltPosition: number): Promise<void>
  valveOpen(deviceId: number): Promise<void>
  valveClose(deviceId: number): Promise<void>
  valveSetPosition(deviceId: number, position: number): Promise<void>
  lockLock(deviceId: number, code: string | undefined): Promise<void>
  lockUnlock(deviceId: number, code: string | undefined): Promise<void>
  mediaPlay(deviceId: number): Promise<void>
  mediaPause(deviceId: number): Promise<void>
  mediaSetVolume(deviceId: number, volumeLevel: number): Promise<void>
  climateSetMode(deviceId: number, mode: HvacMode): Promise<void>
  climateSetTarget(deviceId: number, target: number): Promise<void>
  climateSetFanMode(deviceId: number, fanMode: string): Promise<void>
}

type Args = FanOutCall['args']

function finiteNumber(args: Args, key: string, where: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} needs a finite ${key}`)
  }
  return value
}

function text(args: Args, key: string, where: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} needs a ${key}`)
  return value
}

function flag(args: Args, key: string, where: string): boolean {
  const value = args[key]
  if (typeof value !== 'boolean') throw new Error(`${where} needs a boolean ${key}`)
  return value
}

function optionalText(args: Args, key: string, where: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} needs a ${key}`)
  return value
}

export async function invokeActuatorCall(api: ActuatorInvokeApi, call: FanOutCall): Promise<void> {
  const where = `${call.cap}.${call.method}`
  const id = call.deviceId
  const args = call.args
  switch (where) {
    case 'switch.setState':
      return api.switchSetState(id, flag(args, 'on', where))
    case 'brightness.setBrightness':
      return api.setBrightness(id, finiteNumber(args, 'percentage', where))
    case 'color.setColor': {
      const color = parseColorInput(args.color)
      if (color === null) throw new Error('color.setColor needs a colour mode')
      return api.setColor(id, color)
    }
    case 'fan-control.setPercentage':
      return api.fanSetPercentage(id, finiteNumber(args, 'percentage', where))
    case 'fan-control.setPreset':
      return api.fanSetPreset(id, text(args, 'preset', where))
    case 'fan-control.setDirection': {
      const direction = FanDirectionSchema.safeParse(args.direction)
      if (!direction.success) throw new Error(`${where} needs a direction (forward or reverse)`)
      return api.fanSetDirection(id, direction.data)
    }
    case 'fan-control.setOscillating':
      return api.fanSetOscillating(id, flag(args, 'oscillating', where))
    case 'cover.open':
      return api.coverOpen(id)
    case 'cover.close':
      return api.coverClose(id)
    case 'cover.stop':
      return api.coverStop(id)
    case 'cover.setPosition':
      return api.coverSetPosition(id, finiteNumber(args, 'position', where))
    case 'cover.setTiltPosition':
      return api.coverSetTiltPosition(id, finiteNumber(args, 'tiltPosition', where))
    case 'valve.open':
      return api.valveOpen(id)
    case 'valve.close':
      return api.valveClose(id)
    case 'valve.setPosition':
      return api.valveSetPosition(id, finiteNumber(args, 'position', where))
    case 'lock-control.lock':
      return api.lockLock(id, optionalText(args, 'code', where))
    case 'lock-control.unlock':
      return api.lockUnlock(id, optionalText(args, 'code', where))
    case 'media-player.play':
      return api.mediaPlay(id)
    case 'media-player.pause':
      return api.mediaPause(id)
    case 'media-player.setVolume':
      return api.mediaSetVolume(id, finiteNumber(args, 'volumeLevel', where))
    case 'climate-control.setMode': {
      const mode = HvacModeSchema.safeParse(args.mode)
      if (!mode.success) throw new Error(`${where} needs a mode`)
      return api.climateSetMode(id, mode.data)
    }
    case 'climate-control.setTarget':
      return api.climateSetTarget(id, finiteNumber(args, 'target', where))
    case 'climate-control.setFanMode':
      return api.climateSetFanMode(id, text(args, 'fanMode', where))
    default:
      throw new Error(`no fan-out for ${where}`)
  }
}
