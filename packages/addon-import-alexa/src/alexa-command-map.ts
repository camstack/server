import type { AlexaCommand } from './alexa-client.js'

/**
 * Pure mapping from an addon-internal {@link AlexaCommand} (raised by the device
 * class as `(interfaceName, directive, args)`) to the Alexa Phoenix control
 * parameter object that `executeSmarthomeDeviceAction` puts on the wire
 * (`{ action, ...args }`). The inverse of the directive names the export addon
 * RECEIVES — here we SEND them.
 *
 * Pure + total: an unsupported (interface, directive) pair returns `null` so the
 * client surfaces a clear "unsupported command" error rather than guessing.
 */

type ActionParameters = AlexaRemoteControlParameters

/** A clamped 0..100 integer (percentage-style Alexa parameters). */
function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(0, Math.min(100, n)))
}

/** Map one internal command to its Alexa control parameters, or null. */
export function mapCommandToAlexaAction(command: AlexaCommand): ActionParameters | null {
  const { interfaceName, action, args } = command
  const key = `${interfaceName}/${action}`

  switch (key) {
    case 'Alexa.PowerController/TurnOn':
      return { action: 'turnOn' }
    case 'Alexa.PowerController/TurnOff':
      return { action: 'turnOff' }

    case 'Alexa.BrightnessController/SetBrightness':
      return { action: 'setBrightness', brightness: clampPercent(args?.['brightness']) }

    case 'Alexa.PercentageController/SetPercentage':
      return { action: 'setPercentage', percentage: clampPercent(args?.['percentage']) }

    case 'Alexa.LockController/Lock':
      return { action: 'lock' }
    case 'Alexa.LockController/Unlock':
      return { action: 'unlock' }

    case 'Alexa.SceneController/Activate':
      return { action: 'activate' }

    case 'Alexa.ColorController/SetColor': {
      const color = args?.['color']
      if (color === undefined) return null
      return { action: 'setColor', colorValue: color }
    }

    default:
      return null
  }
}
