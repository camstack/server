import type { HvacMode as CapHvacMode } from '@camstack/types'
import { FanSpeed, HvacMode, HorizontalSwing, VerticalSwing } from '@apocaliss92/nodegree'

/**
 * Pure mapping between the `@apocaliss92/nodegree` AC enums and the CamStack
 * `climate-control` / `fan-control` cap vocabularies. Kept side-effect-free so it
 * is fully unit-testable without a UDP socket.
 */

// ── HVAC mode ──────────────────────────────────────────────────────────────

/**
 * The cap `HvacMode` strings a Gree AC can be IN. Gree has no `off`/`heat_cool`
 * device mode — `off` is the power state (handled separately by `setPower`), and
 * Gree single-setpoint ACs have no dual `heat_cool`. So the device-reported mode
 * is always one of these five when powered on.
 */
export const SUPPORTED_CAP_MODES: readonly CapHvacMode[] = [
  'auto',
  'cool',
  'dry',
  'fan_only',
  'heat',
]

/** The cap modes the provider advertises (`off` is always offered — power off). */
export const ADVERTISED_CAP_MODES: readonly CapHvacMode[] = ['off', ...SUPPORTED_CAP_MODES]

/** Map a library {@link HvacMode} to the cap `HvacMode` string. Pure. */
export function libModeToCapMode(mode: HvacMode): CapHvacMode {
  switch (mode) {
    case HvacMode.Auto:
      return 'auto'
    case HvacMode.Cool:
      return 'cool'
    case HvacMode.Dry:
      return 'dry'
    case HvacMode.Fan:
      return 'fan_only'
    case HvacMode.Heat:
      return 'heat'
  }
}

/**
 * Map a cap `HvacMode` string to the library {@link HvacMode}, or null when the
 * cap mode has no Gree device equivalent (`off` → power off; `heat_cool` →
 * unsupported). The caller turns a null into a power-off / rejection.
 */
export function capModeToLibMode(mode: CapHvacMode): HvacMode | null {
  switch (mode) {
    case 'auto':
      return HvacMode.Auto
    case 'cool':
      return HvacMode.Cool
    case 'dry':
      return HvacMode.Dry
    case 'fan_only':
      return HvacMode.Fan
    case 'heat':
      return HvacMode.Heat
    case 'off':
    case 'heat_cool':
      return null
  }
}

// ── Fan speed ↔ percentage ──────────────────────────────────────────────────

/**
 * Ordered non-auto Gree fan speeds, low→high. Used to map the discrete speed
 * onto the `fan-control` 0..100 percentage surface (Auto is mapped separately to
 * a 0% / "auto preset" — see below).
 */
const ORDERED_SPEEDS: readonly FanSpeed[] = [
  FanSpeed.Low,
  FanSpeed.MediumLow,
  FanSpeed.Medium,
  FanSpeed.MediumHigh,
  FanSpeed.High,
]

/** The setpoint range a Gree AC accepts (its remote's 16-30 C dial), Celsius. */
export const GREE_MIN_TEMP = 16
export const GREE_MAX_TEMP = 30
/** The setpoint granularity of the Gree protocol, Celsius. */
export const GREE_TEMP_STEP = 1

/** The `fan-control` percentage step (5 discrete speeds → 20% per step). */
export const GREE_FAN_PERCENTAGE_STEP = Math.round(100 / ORDERED_SPEEDS.length)

/**
 * Map a library {@link FanSpeed} to a `fan-control` percentage (0..100). `Auto`
 * maps to null (no fixed percentage — the UI shows the `auto` preset instead).
 */
export function fanSpeedToPercentage(speed: FanSpeed): number | null {
  if (speed === FanSpeed.Auto) return null
  const idx = ORDERED_SPEEDS.indexOf(speed)
  if (idx < 0) return null
  // idx 0..4 → 20..100 in even steps.
  return Math.round(((idx + 1) / ORDERED_SPEEDS.length) * 100)
}

/**
 * Map a `fan-control` percentage (0..100) to a library {@link FanSpeed}. 0 → Auto
 * (the device has no "fan off" distinct from power off). Otherwise buckets the
 * percentage into the nearest discrete speed.
 */
export function percentageToFanSpeed(percentage: number): FanSpeed {
  const clamped = Math.max(0, Math.min(100, percentage))
  if (clamped <= 0) return FanSpeed.Auto
  const idx = Math.min(
    ORDERED_SPEEDS.length - 1,
    Math.ceil((clamped / 100) * ORDERED_SPEEDS.length) - 1,
  )
  return ORDERED_SPEEDS[idx] ?? FanSpeed.Auto
}

/** True when the device is in the `Auto` fan-speed mode. */
export function isAutoFan(speed: FanSpeed): boolean {
  return speed === FanSpeed.Auto
}

// ── Swing ↔ oscillating ─────────────────────────────────────────────────────

/**
 * Collapse the Gree vertical + horizontal swing positions into the single
 * `fan-control` `oscillating` boolean. "Oscillating" = either louver is in a
 * full-swing position. Pure.
 *
 * The fine-grained 12-position vertical / 7-position horizontal swing is a
 * flagged TODO — the `fan-control` cap models only a boolean. A later phase could
 * add a vendor swing-position cap.
 */
export function swingToOscillating(vertical: VerticalSwing, horizontal: HorizontalSwing): boolean {
  return vertical === VerticalSwing.FullSwing || horizontal === HorizontalSwing.FullSwing
}

/** The vertical swing position to apply for an `oscillating` toggle. */
export function oscillatingToVerticalSwing(oscillating: boolean): VerticalSwing {
  return oscillating ? VerticalSwing.FullSwing : VerticalSwing.Default
}

// ── Independent vertical / horizontal swing booleans (climate surface) ───────

/**
 * Map the Gree vertical-louver position to the `climate-control`
 * `swingVertical` boolean: true only when the louver is in the full-swing
 * (oscillating) position; every fixed position reads false. Pure.
 *
 * Vertical swing is universal on Gree ACs (no capability flag gates it), so the
 * device always reports a concrete boolean here.
 */
export function verticalSwingToBool(vertical: VerticalSwing): boolean {
  return vertical === VerticalSwing.FullSwing
}

/**
 * Map the Gree horizontal-louver position to the `climate-control`
 * `swingHorizontal` boolean: true only in the full-swing position. Pure.
 *
 * Horizontal swing is capability-gated (`AcCapabilities.horizontalSwing`); the
 * caller surfaces `null` when the model lacks it rather than calling this.
 */
export function horizontalSwingToBool(horizontal: HorizontalSwing): boolean {
  return horizontal === HorizontalSwing.FullSwing
}

/** The vertical swing position to write for a `swingVertical` boolean. Pure. */
export function boolToVerticalSwing(on: boolean): VerticalSwing {
  return on ? VerticalSwing.FullSwing : VerticalSwing.Default
}

/** The horizontal swing position to write for a `swingHorizontal` boolean. Pure. */
export function boolToHorizontalSwing(on: boolean): HorizontalSwing {
  return on ? HorizontalSwing.FullSwing : HorizontalSwing.Default
}

// ── Fan mode (climate `fanMode` surface) ────────────────────────────────────

/**
 * Gree fan-speed names surfaced on the `climate-control` cap's `fanMode` /
 * `availableFanModes` strings, mirroring the HA Gree integration's `fan_modes`
 * attribute (`auto`/`low`/`medium_low`/`medium`/`medium_high`/`high`).
 *
 * NOTE: HA's Gree integration also folds `turbo` and `quiet` INTO `fan_modes`.
 * We deliberately keep turbo/quiet on the dedicated `preset` surface instead
 * (they are independent boolean device flags in the protocol — `Tur` / `Quiet`
 * — not points on the `WdSpd` speed axis), so the speed picker stays a pure
 * speed axis and the two flags stay independently togglable. The `fan-control`
 * percentage surface continues to mirror the same `WdSpd` speed for the
 * fan-style UI.
 */
export const GREE_FAN_MODES: readonly string[] = [
  'auto',
  'low',
  'medium_low',
  'medium',
  'medium_high',
  'high',
]

/** Map a library {@link FanSpeed} to its `climate-control` `fanMode` string. Pure. */
export function fanSpeedToFanMode(speed: FanSpeed): string {
  switch (speed) {
    case FanSpeed.Auto:
      return 'auto'
    case FanSpeed.Low:
      return 'low'
    case FanSpeed.MediumLow:
      return 'medium_low'
    case FanSpeed.Medium:
      return 'medium'
    case FanSpeed.MediumHigh:
      return 'medium_high'
    case FanSpeed.High:
      return 'high'
  }
}

/**
 * Map a `climate-control` `fanMode` string back to a library {@link FanSpeed},
 * or null when the string is not a known Gree speed. Pure.
 */
export function fanModeToFanSpeed(fanMode: string): FanSpeed | null {
  switch (fanMode) {
    case 'auto':
      return FanSpeed.Auto
    case 'low':
      return FanSpeed.Low
    case 'medium_low':
      return FanSpeed.MediumLow
    case 'medium':
      return FanSpeed.Medium
    case 'medium_high':
      return FanSpeed.MediumHigh
    case 'high':
      return FanSpeed.High
    default:
      return null
  }
}

// ── Presets (climate `preset` surface) ──────────────────────────────────────

/**
 * The boolean comfort flags a Gree AC exposes, surfaced on the
 * `climate-control` cap's `preset` / `availablePresets` strings. Each maps to
 * one independent device flag (`Tur` / `Quiet` / `SwhSlp` / `SvSt` / `StHt`).
 *
 * The cap models a single active `preset` string, so the provider treats these
 * as mutually-exclusive at the UI level: selecting one enables its flag and
 * clears the others. `none` clears all. (The underlying flags are physically
 * independent — a future vendor cap could expose them as separate toggles; see
 * the "needs live verification" notes.)
 */
export type GreePreset = 'none' | 'turbo' | 'quiet' | 'sleep' | 'eco' | '8c_heat'

export const GREE_PRESETS: readonly GreePreset[] = [
  'none',
  'turbo',
  'quiet',
  'sleep',
  'eco',
  '8c_heat',
]

/** A snapshot of the five Gree comfort flags, used to derive the active preset. */
export interface GreePresetFlags {
  turbo: boolean
  quiet: boolean
  sleep: boolean
  powerSave: boolean
  steadyHeat: boolean
}

/**
 * Derive the single active `preset` string from the device's comfort flags.
 * Precedence is fixed (turbo > quiet > sleep > eco > 8c_heat) so a coherent
 * single value is reported even if the device has more than one flag set.
 * Returns `'none'` when no flag is set. Pure.
 */
export function presetFromFlags(flags: GreePresetFlags): GreePreset {
  if (flags.turbo) return 'turbo'
  if (flags.quiet) return 'quiet'
  if (flags.sleep) return 'sleep'
  if (flags.powerSave) return 'eco'
  if (flags.steadyHeat) return '8c_heat'
  return 'none'
}

/**
 * Resolve a requested `preset` string to the set of flag writes needed to make
 * it the active one — the chosen flag (if any) true, every other flag false.
 * Returns null when the string is not a known Gree preset. Pure.
 */
export function presetToFlagWrites(preset: string): GreePresetFlags | null {
  const known: readonly string[] = GREE_PRESETS
  if (!known.includes(preset)) return null
  return {
    turbo: preset === 'turbo',
    quiet: preset === 'quiet',
    sleep: preset === 'sleep',
    powerSave: preset === 'eco',
    steadyHeat: preset === '8c_heat',
  }
}
