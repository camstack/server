import {
  switchCapability,
  brightnessCapability,
  colorCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
  type BrightnessStatus,
  type ColorStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * HA-backed light device. Hosts up to three caps in one CamStack
 * device, mirroring how HA models a `light.*` entity:
 *   - `switch` (always)  — on/off via `light.turn_on` / `light.turn_off`
 *   - `brightness` (conditional)  — via `brightness_pct` service-data
 *   - `color` (conditional)  — via `rgb_color` / `hs_color` /
 *     `color_temp_kelvin` service-data, per the discriminated input
 *
 * Cap registration is gated on `persistedConfig.capabilities` so a
 * non-dimmable bulb gets only `switch`, a CCT-only tunable-white bulb
 * gets `switch + brightness + color` (mired-only), a full Hue gets
 * all three with full RGB/HSV/mired support.
 *
 * Push translator decodes HA `state.state` + `state.attributes`
 * (brightness 0..255, color_mode, rgb_color, hs_color, color_temp_kelvin)
 * into per-cap runtime-state slices.
 */
export class HaLightDevice extends HaBaseChildDevice {
  private readonly capSet: ReadonlySet<string>

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as { capabilities?: readonly string[] }
    super(ctx)
    this.capSet = new Set(persisted.capabilities ?? [])

    if (this.capSet.has('switch')) this.registerSwitchCap()
    if (this.capSet.has('brightness')) this.registerBrightnessCap()
    if (this.capSet.has('color')) this.registerColorCap()

    // Cold-start slices.
    if (this.capSet.has('switch')) {
      this.runtimeState.setCapState('switch', { on: false, lastChangedAt: 0 })
    }
    if (this.capSet.has('brightness')) {
      this.runtimeState.setCapState('brightness', { percentage: 0, lastChangedAt: 0 })
    }
    if (this.capSet.has('color')) {
      this.runtimeState.setCapState('color', { mode: 'rgb', lastChangedAt: 0 })
    }
  }

  protected override handleStatePush(state: HaEntityState): void {
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const on = state.state === 'on'

    // switch slice
    if (this.capSet.has('switch')) {
      this.runtimeState.setCapState('switch', { on, lastChangedAt })
    }

    // brightness slice — HA brightness is 0..255; cap is 0..100 %.
    if (this.capSet.has('brightness')) {
      const haBrightness = readNumberAttr(state.attributes, 'brightness')
      if (haBrightness !== null) {
        const percentage = Math.max(0, Math.min(100, Math.round((haBrightness / 255) * 100)))
        this.runtimeState.setCapState('brightness', { percentage, lastChangedAt })
      }
    }

    // color slice — discriminated by HA `color_mode`.
    if (this.capSet.has('color')) {
      const colorMode = state.attributes['color_mode']
      if (typeof colorMode === 'string') {
        const slice = decodeColorSlice(colorMode, state.attributes, lastChangedAt)
        if (slice !== null) this.runtimeState.setCapState('color', slice)
      }
    }
  }

  // ── Cap providers ───────────────────────────────────────────────────

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<SwitchStatus>('switch') ?? { on: false, lastChangedAt: 0 }
        )
      },
      setState: async ({ on }) => {
        await this.callHaService('light', on ? 'turn_on' : 'turn_off')
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }

  private registerBrightnessCap(): void {
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<BrightnessStatus>('brightness') ?? {
            percentage: 0,
            lastChangedAt: 0,
          }
        )
      },
      setBrightness: async ({ percentage }) => {
        // HA `light.turn_on` with `brightness_pct: 0..100`. Setting
        // brightness implicitly turns the light on.
        await this.callHaService('light', 'turn_on', { brightness_pct: percentage })
      },
    }
    this.ctx.registerNativeCap(brightnessCapability, provider)
  }

  private registerColorCap(): void {
    const provider: InferNativeProvider<typeof colorCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<ColorStatus>('color') ?? {
            mode: 'rgb' as const,
            lastChangedAt: 0,
          }
        )
      },
      setColor: async ({ color }) => {
        const payload = colorInputToHaServiceData(color)
        await this.callHaService('light', 'turn_on', payload)
      },
    }
    this.ctx.registerNativeCap(colorCapability, provider)
  }
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}

function decodeColorSlice(
  colorMode: string,
  attrs: Record<string, unknown>,
  lastChangedAt: number,
): ColorStatus | null {
  if (colorMode === 'rgb' || colorMode === 'rgbw' || colorMode === 'rgbww' || colorMode === 'xy') {
    const rgb = attrs['rgb_color']
    if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => typeof v === 'number')) {
      return {
        mode: 'rgb',
        rgb: { r: rgb[0] as number, g: rgb[1] as number, b: rgb[2] as number },
        lastChangedAt,
      }
    }
    return null
  }
  if (colorMode === 'hs') {
    const hs = attrs['hs_color']
    if (Array.isArray(hs) && hs.length === 2 && hs.every((v) => typeof v === 'number')) {
      // HA hs_color: [hue 0..360, saturation 0..100]. The cap also has
      // a `v` channel; we derive it from brightness when available.
      const brightness = readNumberAttr(attrs, 'brightness')
      const v = brightness !== null ? Math.round((brightness / 255) * 100) : 100
      return {
        mode: 'hsv',
        hsv: { h: hs[0] as number, s: hs[1] as number, v },
        lastChangedAt,
      }
    }
    return null
  }
  if (colorMode === 'color_temp') {
    const mireds = readNumberAttr(attrs, 'color_temp')
    if (mireds !== null) {
      return { mode: 'mired', mireds, lastChangedAt }
    }
    return null
  }
  return null
}

function colorInputToHaServiceData(
  color:
    | { mode: 'rgb'; rgb: { r: number; g: number; b: number } }
    | { mode: 'hsv'; hsv: { h: number; s: number; v: number } }
    | { mode: 'mired'; mireds: number },
): Record<string, unknown> {
  switch (color.mode) {
    case 'rgb':
      return { rgb_color: [color.rgb.r, color.rgb.g, color.rgb.b] }
    case 'hsv':
      return {
        hs_color: [color.hsv.h, color.hsv.s],
        brightness_pct: color.hsv.v,
      }
    case 'mired':
      return { color_temp: color.mireds }
  }
}
