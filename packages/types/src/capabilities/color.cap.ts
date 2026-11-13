import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

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
  z.object({
    mode: z.literal('mired'),
    colorTemperature: z.number().int().min(50).max(1000),
  }),
])

export const ColorStatusSchema = z.object({
  /** Active color mode — which of `rgb` / `hsv` / `colorTemperature` reflects
   *  the bulb's current state. */
  mode: z.enum(['rgb', 'hsv', 'mired']),
  /** Populated when `mode === 'rgb'`. */
  rgb: RgbTripletSchema.optional(),
  /** Populated when `mode === 'hsv'`. */
  hsv: HsvTripletSchema.optional(),
  /** Populated when `mode === 'mired'`. */
  colorTemperature: z.number().int().optional().meta(readingMeta('colour-temperature')),
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
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'color.warmWhite',
            label: t('Warm white', 'Bianco caldo'),
            phrase: t('Set {device} to warm white', 'Imposta {device} su bianco caldo'),
            icon: 'sun',
            args: { color: { mode: 'mired', colorTemperature: 370 } },
          },
          {
            id: 'color.coolWhite',
            label: t('Cool white', 'Bianco freddo'),
            phrase: t('Set {device} to cool white', 'Imposta {device} su bianco freddo'),
            icon: 'snowflake',
            args: { color: { mode: 'mired', colorTemperature: 200 } },
          },
          {
            id: 'color.red',
            label: t('Red', 'Rosso'),
            phrase: t('Turn {device} red', 'Colora {device} di rosso'),
            icon: 'palette',
            args: { color: { mode: 'rgb', rgb: { r: 255, g: 0, b: 0 } } },
          },
          {
            id: 'color.green',
            label: t('Green', 'Verde'),
            phrase: t('Turn {device} green', 'Colora {device} di verde'),
            icon: 'palette',
            args: { color: { mode: 'rgb', rgb: { r: 0, g: 255, b: 0 } } },
          },
          {
            id: 'color.blue',
            label: t('Blue', 'Blu'),
            phrase: t('Turn {device} blue', 'Colora {device} di blu'),
            icon: 'palette',
            args: { color: { mode: 'rgb', rgb: { r: 0, g: 0, b: 255 } } },
          },
        ],
      },
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
        colorTemperature: z.number().int().optional(),
        lastChangedAt: z.number(),
      }),
      notOperatorFacing: 'a colour change is read through the `mode` state trigger',
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
  vocabulary: {
    noun: t('Colour', 'Colore'),
    order: 1020,
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Colour mode', 'Modalità colore'),
        values: [
          { value: 'rgb', label: t('RGB colour', 'Colore RGB') },
          { value: 'hsv', label: t('HSV colour', 'Colore HSV') },
          {
            value: 'mired',
            label: t('White temperature', 'Temperatura del bianco'),
          },
        ],
        icon: 'palette',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IColorProvider = InferProvider<typeof colorCapability>
