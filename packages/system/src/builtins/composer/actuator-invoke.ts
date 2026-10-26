/**
 * Turn one fan-out call into the member's existing cap method. A bad argument
 * fails that member only — the caller still attempts the rest.
 */
import { type ColorInput, type FanOutCall, parseColorInput } from '@camstack/types'

export interface ActuatorInvokeApi {
  switchSetState(deviceId: number, on: boolean): Promise<void>
  setBrightness(deviceId: number, percentage: number): Promise<void>
  setColor(deviceId: number, color: ColorInput): Promise<void>
}

export async function invokeActuatorCall(api: ActuatorInvokeApi, call: FanOutCall): Promise<void> {
  if (call.cap === 'switch' && call.method === 'setState') {
    const on = call.args.on
    if (typeof on !== 'boolean') throw new Error('switch.setState needs a boolean on')
    await api.switchSetState(call.deviceId, on)
    return
  }
  if (call.cap === 'brightness' && call.method === 'setBrightness') {
    const percentage = call.args.percentage
    if (typeof percentage !== 'number' || !Number.isFinite(percentage)) {
      throw new Error('brightness.setBrightness needs a finite percentage')
    }
    await api.setBrightness(call.deviceId, percentage)
    return
  }
  if (call.cap === 'color' && call.method === 'setColor') {
    const color = parseColorInput(call.args.color)
    if (color === null) throw new Error('color.setColor needs a colour mode')
    await api.setColor(call.deviceId, color)
    return
  }
  throw new Error(`no fan-out for ${call.cap}.${call.method}`)
}
