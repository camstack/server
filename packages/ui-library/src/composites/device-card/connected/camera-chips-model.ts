import type { UiTextFn } from '../../../contexts/ui-text'
import type { CardGlyph } from '../icons'
import { BATTERY_LOW_PERCENT } from '../shell/model'
import { sinceText } from './since-text'

/** The slice of the generic `battery` cap a chip reads. */
export interface CameraBatterySlice {
  readonly level: number | null
  readonly charging: 'dc' | 'solar' | 'none' | 'unknown'
  readonly sleeping: boolean
}

/** The slice of the generic `low-power-sleep` cap a chip reads. */
export interface CameraSleepSlice {
  readonly sleeping: boolean
}

/** The slice of the generic `motion` cap a chip reads. */
export interface CameraMotionSlice {
  readonly detected: boolean
  readonly lastDetectedAt: number | null
}

/**
 * What the device answered, per generic cap. `undefined` is a cap the device
 * does not bind (or has not answered yet): it draws no chip (D315: unknown is
 * never drawn as a value).
 */
export interface CameraChipInputs {
  readonly battery: CameraBatterySlice | undefined
  readonly sleep: CameraSleepSlice | undefined
  readonly motion: CameraMotionSlice | undefined
}

export interface CameraChip {
  readonly id: 'battery' | 'power' | 'sleep' | 'motion'
  readonly glyph: CardGlyph
  readonly label: string
  readonly tone: 'default' | 'warning'
}

/**
 * The state chips over a camera's scene, from generic caps only: charge level
 * (`battery`), where the power comes from (`battery.charging`), asleep or awake
 * (`low-power-sleep`, else the battery's own flag) and the last motion
 * (`motion`). A chip exists only when its fact is known.
 */
export function cameraChipsOf(
  input: CameraChipInputs,
  now: number,
  t: UiTextFn,
): readonly CameraChip[] {
  const chips: CameraChip[] = []
  const { battery, motion } = input
  if (battery !== undefined && typeof battery.level === 'number') {
    const low = battery.level <= BATTERY_LOW_PERCENT
    chips.push({
      id: 'battery',
      glyph: low ? 'batteryLow' : 'battery',
      label: `${String(Math.round(battery.level))}%`,
      tone: low ? 'warning' : 'default',
    })
  }
  if (battery !== undefined && battery.charging !== 'unknown') {
    chips.push({
      id: 'power',
      glyph: battery.charging === 'solar' ? 'solar' : 'supply',
      label:
        battery.charging === 'dc'
          ? t('uiLibrary.deviceCard.camera.wired', 'Wired')
          : battery.charging === 'solar'
            ? t('uiLibrary.deviceCard.camera.solar', 'Solar')
            : t('uiLibrary.deviceCard.camera.onBattery', 'Battery'),
      tone: 'default',
    })
  }
  const sleeping = input.sleep?.sleeping ?? battery?.sleeping
  if (sleeping !== undefined) {
    chips.push({
      id: 'sleep',
      glyph: sleeping ? 'night' : 'wake',
      label: sleeping
        ? t('uiLibrary.deviceCard.camera.asleep', 'Asleep')
        : t('uiLibrary.deviceCard.camera.awake', 'Awake'),
      tone: 'default',
    })
  }
  if (motion !== undefined) {
    const since = sinceText(motion.lastDetectedAt, now, t)
    if (motion.detected) {
      chips.push({
        id: 'motion',
        glyph: 'motion',
        label: t('uiLibrary.deviceCard.camera.motionNow', 'Motion now'),
        tone: 'warning',
      })
    } else if (since !== undefined) {
      chips.push({
        id: 'motion',
        glyph: 'motion',
        label: t('uiLibrary.deviceCard.camera.motionSince', 'Motion {{since}} ago', { since }),
        tone: 'default',
      })
    }
  }
  return chips
}
