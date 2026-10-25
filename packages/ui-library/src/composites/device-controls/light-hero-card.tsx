import type { ReactNode } from 'react'
import { Lightbulb, Thermometer } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useUiText } from '../../contexts/ui-text'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import type { BrightnessStatus, ColorStatus, SwitchStatus } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { GripTrack } from './atoms'
import { RadialGauge } from './radial-gauge'
import { TapToggle } from './tap-toggle'

// ── Cap surfaces ──────────────────────────────────────────────────────────────
// Named cap types; the accessor performs the documented cap-access boundary
// narrowing (mirrors brightness-panel.tsx / lock-hero-card.tsx).

type SwitchCap = { setState: (i: { on: boolean }) => Promise<void> }
type BrightnessCap = { setBrightness: (i: { percentage: number }) => Promise<void> }
type ColorCap = {
  setColor: (i: { color: { mode: 'mired'; mireds: number } }) => Promise<void>
}

// ── Colour-temperature mapping ────────────────────────────────────────────────
// Tunable-white bulbs report colour temperature in mireds (reciprocal megakelvin):
// warm ≈ 500 mireds (~2000K), cool ≈ 150 mireds (~6500K). We normalize within
// this practical band. The native range input runs cool(150,left) → warm(500,
// right); the GripTrack marker and gradient must travel the SAME direction.
const CT_WARM_MIREDS = 500
const CT_COOL_MIREDS = 150

/** Cool hue at fraction 0 (left), warm hue at fraction 1 (right) — matches the native thumb. */
const CT_STRIP_GRADIENT = 'linear-gradient(90deg, #9ec9ff, #ffffff, #ffb24d)'

/** Compute a 0..1 fraction clamped within [min, max]. */
function toFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

/** Colour-temp fraction: cool(150 mireds)→0, warm(500 mireds)→1 — same as the native thumb. */
function ctFraction(mireds: number): number {
  return toFraction(mireds, CT_COOL_MIREDS, CT_WARM_MIREDS)
}

/** On = warm amber arc, off = muted track colour. */
const ARC_COLOR_ON = '#f4b740'
const ARC_COLOR_OFF = '#d4d4d8'

// ── LightHeroCard ─────────────────────────────────────────────────────────────

/**
 * LightHeroCard — radial dimmer hero for Light devices.
 *
 * Renders:
 *  - RadialGauge: brightness ArcKnob riding a 270° ring at the level fraction,
 *    centered bulb glyph + percentage readout.
 *  - TAP TOGGLE for on/off (Spec §3 — NOT a SlideToggle; slide is safety-only).
 *  - Colour-temperature GripTrack strip — ONLY when the device advertises
 *    DeviceFeature.LightColorMired AND the `color` cap is bound.
 *
 * Composes three caps: `switch` (on/off), `brightness` (level), `color` (CT).
 * Cap-gated on `switch` (always present on a Light) — returns null without it.
 */
export function LightHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const sw = useDeviceCapability<SwitchCap, SwitchStatus>({
    trpc,
    deviceId,
    cap: (d) => d.switch as SwitchCap | undefined,
    slice: (d) => d.state.switch,
  })
  const bright = useDeviceCapability<BrightnessCap, BrightnessStatus>({
    trpc,
    deviceId,
    cap: (d) => d.brightness as BrightnessCap | undefined,
    slice: (d) => d.state.brightness,
  })
  const color = useDeviceCapability<ColorCap, ColorStatus>({
    trpc,
    deviceId,
    cap: (d) => d.color as ColorCap | undefined,
    slice: (d) => d.state.color,
  })

  const swOpt = useOptimisticSlice<SwitchStatus>(sw.slice, { enabled: optimistic ?? true })
  const brightOpt = useOptimisticSlice<BrightnessStatus>(bright.slice, {
    enabled: optimistic ?? true,
  })
  const colorOpt = useOptimisticSlice<ColorStatus>(color.slice, { enabled: optimistic ?? true })

  // Cap-gate on switch — a Light always exposes on/off.
  if (sw.cap === undefined) return null
  if (swOpt.display === undefined) return null

  const on = swOpt.display.on === true
  const swBusy = !sw.available

  const percentage = brightOpt.display?.percentage ?? 0
  const brightBusy = !bright.available
  const fraction = on ? percentage / 100 : 0
  const arcColor = on ? ARC_COLOR_ON : ARC_COLOR_OFF

  const supportsCt =
    (features?.includes(DeviceFeature.LightColorMired) ?? false) && color.cap !== undefined
  const ctMireds = colorOpt.display?.mireds
  const ctBusy = !color.available

  const handleToggle = (): void => {
    if (swBusy) return
    const next = !on
    swOpt.applyOptimistic({ on: next })
    void sw.cap?.setState({ on: next })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Radial dimmer ──────────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-3">
        <RadialGauge fraction={fraction} color={arcColor}>
          <div
            data-testid="brightness-readout"
            className="text-3xl font-bold tabular-nums text-foreground leading-none"
          >
            {percentage}
            <span className="text-base text-foreground-subtle font-normal ml-0.5">%</span>
          </div>
          <Lightbulb className="h-5 w-5 text-foreground-subtle" aria-hidden="true" />
        </RadialGauge>

        {/* Brightness slider — only when the brightness cap is bound (else a
            stuck disabled 0% slider would render). */}
        {bright.cap !== undefined && (
          <label className="flex w-full items-center gap-2 text-xs text-foreground-subtle">
            <span className="w-16">{t('uiLibrary.lightHeroCard.brightness', 'Brightness')}</span>
            <input
              aria-label={t('uiLibrary.lightHeroCard.brightness', 'Brightness')}
              type="range"
              min={0}
              max={100}
              step={1}
              className="flex-1"
              value={percentage}
              disabled={brightBusy || !on}
              onChange={(e) => {
                const pct = Number(e.target.value)
                brightOpt.applyOptimistic({ percentage: pct })
                if (!brightBusy) void bright.cap?.setBrightness({ percentage: pct })
              }}
            />
            <span className="tabular-nums w-9 text-right">{percentage}%</span>
          </label>
        )}
      </div>

      {/* ── On/off TAP TOGGLE (NOT a slide) ────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground-muted">
          {on ? t('uiLibrary.lightHeroCard.on', 'On') : t('uiLibrary.lightHeroCard.off', 'Off')}
        </span>
        <TapToggle on={on} busy={swBusy} onToggle={handleToggle} />
      </div>

      {/* ── Colour-temperature strip (only when CT supported) ──────────────── */}
      {supportsCt && (
        <div className="flex items-center gap-2" data-testid="color-temp-strip">
          <Thermometer className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
          <label className="flex-1">
            <span className="sr-only">
              {t('uiLibrary.lightHeroCard.colourTemperature', 'Colour temperature')}
            </span>
            <input
              aria-label={t('uiLibrary.lightHeroCard.colourTemperature', 'Colour temperature')}
              type="range"
              min={CT_COOL_MIREDS}
              max={CT_WARM_MIREDS}
              step={1}
              className="w-full"
              value={ctMireds ?? CT_WARM_MIREDS}
              disabled={ctBusy || !on}
              onChange={(e) => {
                const mireds = Number(e.target.value)
                colorOpt.applyOptimistic({ mode: 'mired', mireds })
                if (!ctBusy) void color.cap?.setColor({ color: { mode: 'mired', mireds } })
              }}
            />
            <div className="pointer-events-none mt-1">
              <GripTrack
                fraction={ctMireds !== undefined ? ctFraction(ctMireds) : 0.5}
                color={CT_STRIP_GRADIENT}
              />
            </div>
          </label>
        </div>
      )}
    </div>
  )
}
