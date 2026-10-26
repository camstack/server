import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Color-light cap. Coexists with `switch` (on/off) and `brightness`
 * (level) on the same device — `switch` toggles the bulb, `brightness`
 * sets the dim level, this cap sets the chromaticity.
 *
 * Three mutually-exclusive color modes are modelled — a single
 * `setColor` mutation accepts whichever mode the caller wants and
 * the provider rejects modes the bulb doesn't support:
 *  - `rgb` — direct red/green/blue triplet (0..255 each).
 *  - `hsv` — hue/saturation/value (0..360 / 0..100 / 0..100).
 *  - `mired` — color-temperature reciprocal in mireds (warm ≈ 500,
 *    cool ≈ 150). Used by tunable-white bulbs.
 *
 * The slice carries the LAST-applied mode + its associated value;
 * the provider does NOT auto-convert between modes (e.g. setting
 * mireds zeroes out the rgb/hsv fields). UI surfaces a single
 * color picker that picks one mode per interaction.
 *
 * Sub-feature gating uses the granular `DeviceFeature.LightColorRgb`
 * / `LightColorHsv` / `LightColorMired` flags — a Hue full-color
 * bulb sets all three; a CCT-only tunable-white bulb sets only
 * `LightColorMired`. The UI uses these flags to decide which color
 * modes to expose in the picker without a slice fetch.
 */

const RgbTripletSchema = z.object({
  r: z.number().int().min(0).max(255).meta(readingMeta('none')),
  g: z.number().int().min(0).max(255).meta(readingMeta('none')),
  b: z.number().int().min(0).max(255).meta(readingMeta('none')),
})

const HsvTripletSchema = z.object({
  /** Hue in degrees, 0..360. */
  h: z.number().min(0).max(360).meta(readingMeta('none')),
  /** Saturation as 0..100 inclusive. */
  s: z.number().min(0).max(100).meta(readingMeta('none')),
  /** Value/brightness as 0..100 inclusive. */
  v: z.number().min(0).max(100).meta(readingMeta('none')),
})

const ColorInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('rgb'), rgb: RgbTripletSchema }),
  z.object({ mode: z.literal('hsv'), hsv: HsvTripletSchema }),
  z.object({ mode: z.literal('mired'), mireds: z.number().int().min(50).max(1000) }),
])

export const ColorStatusSchema = z.object({
  /** Active color mode — which of `rgb` / `hsv` / `mireds` reflects
   *  the bulb's current state. */
  mode: z.enum(['rgb', 'hsv', 'mired']),
  /** Populated when `mode === 'rgb'`. */
  rgb: RgbTripletSchema.optional(),
  /** Populated when `mode === 'hsv'`. */
  hsv: HsvTripletSchema.optional(),
  /** Populated when `mode === 'mired'`. */
  mireds: z.number().int().optional().meta(readingMeta('colour-temperature')),
  /** Ms epoch of the last operator-driven change. */
  lastChangedAt: z.number(),
})

export type ColorStatus = z.infer<typeof ColorStatusSchema>
export type ColorRgbTriplet = z.infer<typeof RgbTripletSchema>
export type ColorHsvTriplet = z.infer<typeof HsvTripletSchema>
export type ColorInput = z.infer<typeof ColorInputSchema>

export function parseColorInput(value: unknown): ColorInput | null {
  const parsed = ColorInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export const colorCapability = {
  name: 'color',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Light],
  methods: {
    setColor: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        color: ColorInputSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  events: {
    /**
     * Emitted whenever the color changes — operator action OR firmware
     * push. Subscribers (UI color pickers, automation engines) react
     * without polling.
     */
    onColorChanged: {
      data: z.object({
        deviceId: z.number(),
        mode: z.enum(['rgb', 'hsv', 'mired']),
        rgb: RgbTripletSchema.optional(),
        hsv: HsvTripletSchema.optional(),
        mireds: z.number().int().optional(),
        lastChangedAt: z.number(),
      }),
    },
  },
  status: {
    schema: ColorStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Runtime-state slice — the last applied color, mirrored by the
   * kernel. Read via `device.state.color.value` so UI pickers surface
   * the current chromaticity without polling the provider.
   */
  runtimeState: ColorStatusSchema,

  /**
   * Runtime-state durability: **session** — as `brightness`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — nested and cosmetic.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IColorProvider = InferProvider<typeof colorCapability>
