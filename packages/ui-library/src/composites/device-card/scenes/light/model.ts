import type { LightRgb } from '../../illustrations/LightIllustration'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** The white range the Bianco popover offers, in kelvin. */
export const LIGHT_WHITE_MIN_K = 2700
export const LIGHT_WHITE_MAX_K = 6500
export const LIGHT_WHITE_STEP_K = 100

/** The palette of the Colour popover: colours SENT to the device (data, not theme colours). */
export const LIGHT_PALETTE: readonly LightRgb[] = [
  { r: 255, g: 179, b: 92 },
  { r: 255, g: 107, b: 107 },
  { r: 255, g: 154, b: 213 },
  { r: 178, g: 141, b: 255 },
  { r: 106, g: 168, b: 255 },
  { r: 95, g: 211, b: 181 },
  { r: 166, g: 227, b: 107 },
  { r: 255, g: 241, b: 199 },
]

export interface LightCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  /** 1..100; null for a light without a level. */
  readonly brightness: number | null
  /** The colour it shines with, as reported; null draws the theme's lit colour. */
  readonly color: LightRgb | null
  /** It takes a colour (rgb or hsv): the Colour popover. */
  readonly palette: boolean
  /** It takes a white temperature: the White popover, at this kelvin (null = not reported). */
  readonly white: { readonly kelvin: number | null } | null
}

export interface LightCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onBrightness: (level: number) => void
  readonly onColor: (color: LightRgb) => void
  readonly onWhite: (kelvin: number) => void
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/** A white temperature drawn as a colour, warm to cold, as in the approved drawing. */
export function kelvinRgb(kelvin: number): LightRgb {
  const f = Math.max(
    0,
    Math.min(1, (kelvin - LIGHT_WHITE_MIN_K) / (LIGHT_WHITE_MAX_K - LIGHT_WHITE_MIN_K)),
  )
  return { r: 255, g: clampByte(200 + f * 45), b: clampByte(120 + f * 135) }
}

/** Hue 0..360, saturation and value 0..100, to 0..255 channels. */
export function hsvRgb(h: number, s: number, v: number): LightRgb {
  const sat = s / 100
  const val = v / 100
  const k = (n: number): number => (n + h / 60) % 6
  const f = (n: number): number => val - val * sat * Math.max(0, Math.min(k(n), 4 - k(n), 1))
  return { r: clampByte(f(5) * 255), g: clampByte(f(3) * 255), b: clampByte(f(1) * 255) }
}

/** Mireds (the cap's unit) to kelvin, and back. */
export const miredToKelvin = (mired: number): number => Math.round(1_000_000 / mired)
export const kelvinToMired = (kelvin: number): number => Math.round(1_000_000 / kelvin)
