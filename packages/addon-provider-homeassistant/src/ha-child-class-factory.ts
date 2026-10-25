import type { IDevice, DeviceContext } from '@camstack/types'
import { HaButtonDevice } from './devices/ha-button-device.js'
import { HaUpdateDevice } from './devices/ha-update-device.js'
import { HaSwitchDevice } from './devices/ha-switch-device.js'
import { HaNumericSensorDevice, hostsNumericSensor } from './devices/ha-numeric-sensor-device.js'
import { HaBinarySensorDevice, hostsBinarySensor } from './devices/ha-binary-sensor-device.js'
import { HaLightDevice } from './devices/ha-light-device.js'
import { HaCoverDevice } from './devices/ha-cover-device.js'
import { HaValveDevice } from './devices/ha-valve-device.js'
import { HaLockDevice } from './devices/ha-lock-device.js'
import { HaClimateDevice } from './devices/ha-climate-device.js'
import { HaHumidifierDevice } from './devices/ha-humidifier-device.js'
import { HaWaterHeaterDevice } from './devices/ha-water-heater-device.js'
import { HaFanDevice } from './devices/ha-fan-device.js'
import { HaVacuumDevice } from './devices/ha-vacuum-device.js'
import { HaLawnMowerDevice } from './devices/ha-lawn-mower-device.js'
import { HaMediaPlayerDevice } from './devices/ha-media-player-device.js'
import { HaAlarmPanelDevice } from './devices/ha-alarm-panel-device.js'
import { HaPresenceDevice } from './devices/ha-presence-device.js'
import { HaControlDevice } from './devices/ha-control-device.js'
import { HaScriptDevice } from './devices/ha-script-device.js'
import { HaAutomationDevice } from './devices/ha-automation-device.js'
import { HaNotifierDevice } from './devices/ha-notifier-device.js'
import { HaPowerMeterDevice } from './devices/ha-power-meter-device.js'
import { HaAirQualityDevice } from './devices/ha-air-quality-device.js'
import { HaEnumSensorDevice } from './devices/ha-enum-sensor-device.js'
import { HaEventEmitterDevice } from './devices/ha-event-emitter-device.js'
import { HaWeatherDevice } from './devices/ha-weather-device.js'
import { HaImageDevice } from './devices/ha-image-device.js'

/** Every HA device class (per-domain subclasses via HaBaseChildDevice)
 *  exposes setAccessoryChildren so the accessories cap can be wired. */
type HaDeviceConstructor = new (
  ctx: DeviceContext,
) => IDevice & { setAccessoryChildren(ids: readonly number[]): void }

/**
 * Pick the concrete HA-child class to instantiate for an adopted
 * entity. Priority (first match wins) — higher-cap-count classes
 * win so multi-cap entities (light, fan) route to the right
 * combined-class instead of being shredded by a single-cap class.
 *
 * Coverage:
 *   1. button                → HaButtonDevice   (fire-only actuator, no status)
 *   2. update                → HaUpdateDevice   (firmware/software descriptor)
 *   3. brightness / color    → HaLightDevice    (switch + brightness + color)
 *   4. climate-control       → HaClimateDevice
 *   4a. humidifier           → HaHumidifierDevice   (climate-family actuator)
 *   4b. water-heater         → HaWaterHeaterDevice  (climate-family actuator)
 *   5. cover                 → HaCoverDevice
 *   6. valve                 → HaValveDevice    (cover-sibling actuator, no tilt)
 *   7. lock-control          → HaLockDevice
 *   8. fan-control           → HaFanDevice      (switch + fan-control)
 *   9. vacuum-control        → HaVacuumDevice
 *  10. lawn-mower-control    → HaLawnMowerDevice
 *  11. media-player          → HaMediaPlayerDevice
 *  12. alarm-panel           → HaAlarmPanelDevice
 *  13. presence              → HaPresenceDevice (read-only)
 *  14. control               → HaControlDevice  (4 kinds discriminated)
 *  15. script-runner         → HaScriptDevice
 *  16. automation-control    → HaAutomationDevice
 *  17. notifier              → HaNotifierDevice
 *  18. event-emitter         → HaEventEmitterDevice (fire-only, verbatim vocab)
 *  18a. weather              → HaWeatherDevice  (read-only display)
 *  18b. image                → HaImageDevice    (read-only display; also HA `camera.*`)
 *  19. switch                → HaSwitchDevice
 *  20. power-meter           → HaPowerMeterDevice
 *  21. air-quality-sensor    → HaAirQualityDevice
 *  22. enum-sensor           → HaEnumSensorDevice
 *  23. any numeric-sensor    → HaNumericSensorDevice
 *  24. any binary-sensor     → HaBinarySensorDevice
 *  Otherwise: throws — discovery already skips unmapped entities so
 *    this branch indicates an internal mapping gap.
 */
export function tryPickHaChildClass(capabilities: readonly string[]): HaDeviceConstructor | null {
  if (capabilities.includes('button')) return HaButtonDevice
  if (capabilities.includes('update')) return HaUpdateDevice
  if (capabilities.includes('brightness') || capabilities.includes('color')) return HaLightDevice
  if (capabilities.includes('climate-control')) return HaClimateDevice
  if (capabilities.includes('humidifier')) return HaHumidifierDevice
  if (capabilities.includes('water-heater')) return HaWaterHeaterDevice
  if (capabilities.includes('cover')) return HaCoverDevice
  if (capabilities.includes('valve')) return HaValveDevice
  if (capabilities.includes('lock-control')) return HaLockDevice
  if (capabilities.includes('fan-control')) return HaFanDevice
  if (capabilities.includes('vacuum-control')) return HaVacuumDevice
  if (capabilities.includes('lawn-mower-control')) return HaLawnMowerDevice
  if (capabilities.includes('media-player')) return HaMediaPlayerDevice
  if (capabilities.includes('alarm-panel')) return HaAlarmPanelDevice
  if (capabilities.includes('presence')) return HaPresenceDevice
  if (capabilities.includes('control')) return HaControlDevice
  if (capabilities.includes('script-runner')) return HaScriptDevice
  if (capabilities.includes('automation-control')) return HaAutomationDevice
  if (capabilities.includes('notifier')) return HaNotifierDevice
  if (capabilities.includes('event-emitter')) return HaEventEmitterDevice
  if (capabilities.includes('weather')) return HaWeatherDevice
  if (capabilities.includes('image')) return HaImageDevice
  if (capabilities.includes('switch')) return HaSwitchDevice
  if (capabilities.includes('power-meter')) return HaPowerMeterDevice
  if (capabilities.includes('air-quality-sensor')) return HaAirQualityDevice
  if (capabilities.includes('enum-sensor')) return HaEnumSensorDevice
  if (hostsNumericSensor(capabilities)) return HaNumericSensorDevice
  if (hostsBinarySensor(capabilities)) return HaBinarySensorDevice
  return null
}

/**
 * Pick the concrete HA-child class for a set of capabilities, throwing when
 * none matches. Discovery already skips unmapped entities, so a throw here
 * indicates an internal mapping gap.
 */
export function pickHaChildClass(capabilities: readonly string[]): HaDeviceConstructor {
  const cls = tryPickHaChildClass(capabilities)
  if (cls === null) {
    throw new Error(
      `pickHaChildClass: no HA child class for capabilities: ${capabilities.join(',')}`,
    )
  }
  return cls
}
