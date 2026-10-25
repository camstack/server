/**
 * Weather controls for a `DeviceType.Weather` device.
 *
 * Read-only: the `weather` cap has no setters. Reads the `weather` cap
 * status slice (condition + current temperature / humidity / pressure /
 * wind) and renders:
 *   - WeatherInlineControl (device-list row): a compact condition icon +
 *     temperature readout. Row-narrow.
 *   - WeatherHeroCard (device-detail hero): a bespoke state-tinted sky
 *     scene SVG in the framed-box language whose graphic varies by HA
 *     `condition`, plus a big temperature readout and humidity / wind /
 *     pressure readouts. Pure — no controls. Decorative SVG aria-hidden.
 *
 * Mirrors the climate / humidifier controls' `useDeviceCapability` read
 * pattern so the row and hero never diverge. The condition→glyph map is
 * a small internal switch over the known HA condition set with a neutral
 * default.
 */
import { useId, type ReactNode } from 'react'
import {
  Sun,
  Moon,
  Cloud,
  CloudSun,
  CloudRain,
  CloudSnow,
  CloudLightning,
  CloudFog,
  Wind,
  Droplets,
  Gauge,
  Navigation,
} from 'lucide-react'
import type { WeatherStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** Which sky glyph a condition maps to. Drives both the inline icon and
 *  the hero scene's graphic branch. */
export type WeatherGlyph =
  | 'sun'
  | 'clear-night'
  | 'partly-cloudy'
  | 'cloudy'
  | 'rain'
  | 'snow'
  | 'lightning'
  | 'fog'
  | 'wind'
  | 'hail'

export interface WeatherConditionMeta {
  /** Human-readable label for the condition. */
  readonly label: string
  /** Which glyph to render. */
  readonly glyph: WeatherGlyph
}

export interface WeatherTint {
  /** Tailwind class for the wash behind the scene. */
  readonly glow: string
  /** Tailwind text token driving the scene glyph via currentColor. */
  readonly accent: string
}

/**
 * Pure helper — maps a verbatim HA condition string to a label + glyph.
 * Covers the known HA `weather.*` condition set; an unknown / null
 * condition falls back to a neutral cloud.
 */
export function weatherConditionMeta(
  condition: string | null,
  t: UiTextFn = defaultUiText,
): WeatherConditionMeta {
  switch (condition) {
    case 'sunny':
      return { label: t('uiLibrary.weatherControl.sunny', 'Sunny'), glyph: 'sun' }
    case 'clear-night':
      return {
        label: t('uiLibrary.weatherControl.clearNight', 'Clear night'),
        glyph: 'clear-night',
      }
    case 'partlycloudy':
      return {
        label: t('uiLibrary.weatherControl.partlyCloudy', 'Partly cloudy'),
        glyph: 'partly-cloudy',
      }
    case 'cloudy':
      return { label: t('uiLibrary.weatherControl.cloudy', 'Cloudy'), glyph: 'cloudy' }
    case 'rainy':
      return { label: t('uiLibrary.weatherControl.rainy', 'Rainy'), glyph: 'rain' }
    case 'pouring':
      return { label: t('uiLibrary.weatherControl.pouring', 'Pouring'), glyph: 'rain' }
    case 'snowy':
      return { label: t('uiLibrary.weatherControl.snowy', 'Snowy'), glyph: 'snow' }
    case 'snowy-rainy':
      return { label: t('uiLibrary.weatherControl.sleet', 'Sleet'), glyph: 'snow' }
    case 'lightning':
      return { label: t('uiLibrary.weatherControl.lightning', 'Lightning'), glyph: 'lightning' }
    case 'lightning-rainy':
      return {
        label: t('uiLibrary.weatherControl.thunderstorm', 'Thunderstorm'),
        glyph: 'lightning',
      }
    case 'fog':
      return { label: t('uiLibrary.weatherControl.fog', 'Fog'), glyph: 'fog' }
    case 'windy':
      return { label: t('uiLibrary.weatherControl.windy', 'Windy'), glyph: 'wind' }
    case 'windy-variant':
      return { label: t('uiLibrary.weatherControl.windy', 'Windy'), glyph: 'wind' }
    case 'hail':
      return { label: t('uiLibrary.weatherControl.hail', 'Hail'), glyph: 'hail' }
    case 'exceptional':
      return { label: t('uiLibrary.weatherControl.exceptional', 'Exceptional'), glyph: 'cloudy' }
    case null:
      return { label: t('uiLibrary.weatherControl.unknown', 'Unknown'), glyph: 'cloudy' }
    default:
      return { label: condition, glyph: 'cloudy' }
  }
}

/**
 * Pure helper — maps a verbatim HA condition string to a tint. Exhaustive
 * over the known condition set with a neutral default.
 */
export function weatherTint(condition: string | null): WeatherTint {
  switch (condition) {
    case 'sunny':
      return { glow: 'bg-warning/15', accent: 'text-warning' }
    case 'clear-night':
      return { glow: 'bg-primary/10', accent: 'text-primary' }
    case 'partlycloudy':
      return { glow: 'bg-warning/10', accent: 'text-warning' }
    case 'cloudy':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle' }
    case 'rainy':
    case 'pouring':
      return { glow: 'bg-primary/15', accent: 'text-primary' }
    case 'snowy':
    case 'snowy-rainy':
      return { glow: 'bg-primary/10', accent: 'text-primary' }
    case 'lightning':
    case 'lightning-rainy':
      return { glow: 'bg-warning/20', accent: 'text-warning' }
    case 'fog':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle' }
    case 'windy':
    case 'windy-variant':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle' }
    case 'hail':
      return { glow: 'bg-primary/10', accent: 'text-primary' }
    default:
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle' }
  }
}

/** Inline lucide glyph for the compact row icon. */
function inlineGlyph(glyph: WeatherGlyph): ReactNode {
  const cls = 'h-4 w-4'
  switch (glyph) {
    case 'sun':
      return <Sun className={cls} />
    case 'clear-night':
      return <Moon className={cls} />
    case 'partly-cloudy':
      return <CloudSun className={cls} />
    case 'cloudy':
      return <Cloud className={cls} />
    case 'rain':
      return <CloudRain className={cls} />
    case 'snow':
      return <CloudSnow className={cls} />
    case 'lightning':
      return <CloudLightning className={cls} />
    case 'fog':
      return <CloudFog className={cls} />
    case 'wind':
      return <Wind className={cls} />
    case 'hail':
      return <CloudSnow className={cls} />
    default: {
      // Exhaustive guard — fails to compile if a new WeatherGlyph is added.
      glyph satisfies never
      return null
    }
  }
}

function useWeather(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<unknown, WeatherStatus>({
    trpc,
    deviceId,
    cap: (d) => d.weather,
    slice: (d) => d.state.weather,
  })
}

/** Format a temperature + unit readout (e.g. `21°C`). */
function formatTemp(temp: number | null, unit: string | null): string {
  if (temp === null) return '—'
  return `${Math.round(temp)}${unit ?? '°'}`
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * WeatherInlineControl — compact condition icon + temperature readout
 * for a device-list row. Read-only; must NOT blow out the row width.
 */
export function WeatherInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { slice } = useWeather(trpc, deviceId)
  if (slice === undefined) return null

  const meta = weatherConditionMeta(slice.condition, t)
  const tint = weatherTint(slice.condition)

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-foreground-subtle">
      <span className={cn('inline-flex', tint.accent)} title={meta.label} aria-label={meta.label}>
        {inlineGlyph(meta.glyph)}
      </span>
      <span className="tabular-nums">{formatTemp(slice.temperature, slice.temperatureUnit)}</span>
    </div>
  )
}

// ── Sky scene graphic ─────────────────────────────────────────────────────────

interface WeatherSceneProps {
  readonly glyph: WeatherGlyph
  readonly tint: WeatherTint
}

/**
 * WeatherScene — a framed bespoke sky-scene SVG in the SAME visual
 * language as the valve / humidifier graphic (w-28 h-36 rounded bordered
 * box, gradient bg, overflow-hidden, inset white shadow).
 *
 * The graphic branches on `glyph`: sun, sun+cloud, clouds, cloud+rain,
 * cloud+snow, cloud+bolt, haze lines, gusts. State-tinted. Decorative —
 * aria-hidden.
 */
function WeatherScene({ glyph, tint }: WeatherSceneProps): ReactNode {
  const uid = useId()
  return (
    <div
      data-testid="weather-scene"
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />
      <div className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}>
        <svg viewBox="0 0 100 100" className="w-24 h-28" fill="none" data-glyph={glyph}>
          {renderScene(glyph, uid)}
        </svg>
      </div>
    </div>
  )
}

/** Reusable cloud silhouette path. */
function Cloudlet({ cx, cy, scale = 1 }: { cx: number; cy: number; scale?: number }): ReactNode {
  return (
    <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
      <path
        d="M-22 8 a13 13 0 0 1 4 -25 a16 16 0 0 1 30 4 a11 11 0 0 1 -2 21 Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </g>
  )
}

function renderScene(glyph: WeatherGlyph, uid: string): ReactNode {
  switch (glyph) {
    case 'sun':
      return (
        <g>
          <circle
            cx="50"
            cy="48"
            r="16"
            fill="currentColor"
            fillOpacity="0.18"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
              const r = (deg * Math.PI) / 180
              return (
                <line
                  key={`${uid}-ray-${deg}`}
                  x1={50 + Math.cos(r) * 22}
                  y1={48 + Math.sin(r) * 22}
                  x2={50 + Math.cos(r) * 30}
                  y2={48 + Math.sin(r) * 30}
                />
              )
            })}
          </g>
        </g>
      )
    case 'clear-night':
      return (
        <g>
          <path
            d="M62 30 a22 22 0 1 0 8 38 a18 18 0 0 1 -8 -38 Z"
            fill="currentColor"
            fillOpacity="0.18"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle cx="34" cy="32" r="1.6" fill="currentColor" />
          <circle cx="28" cy="48" r="1.2" fill="currentColor" />
          <circle cx="40" cy="62" r="1.4" fill="currentColor" />
        </g>
      )
    case 'partly-cloudy':
      return (
        <g>
          <circle
            cx="38"
            cy="38"
            r="12"
            fill="currentColor"
            fillOpacity="0.18"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            {[200, 240, 300].map((deg) => {
              const r = (deg * Math.PI) / 180
              return (
                <line
                  key={`${uid}-pcray-${deg}`}
                  x1={38 + Math.cos(r) * 16}
                  y1={38 + Math.sin(r) * 16}
                  x2={38 + Math.cos(r) * 22}
                  y2={38 + Math.sin(r) * 22}
                />
              )
            })}
          </g>
          <Cloudlet cx={58} cy={60} />
        </g>
      )
    case 'cloudy':
      return (
        <g>
          <Cloudlet cx={40} cy={44} scale={0.9} />
          <Cloudlet cx={62} cy={58} />
        </g>
      )
    case 'rain':
      return (
        <g>
          <Cloudlet cx={50} cy={42} />
          <g
            className="animate-pulse"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.7"
          >
            <line x1="38" y1="62" x2="34" y2="78" />
            <line x1="50" y1="62" x2="46" y2="80" />
            <line x1="62" y1="62" x2="58" y2="78" />
          </g>
        </g>
      )
    case 'snow':
      return (
        <g>
          <Cloudlet cx={50} cy={42} />
          <g fill="currentColor" opacity="0.8" className="animate-pulse">
            <circle cx="38" cy="70" r="2.5" />
            <circle cx="50" cy="76" r="2.5" />
            <circle cx="62" cy="70" r="2.5" />
          </g>
        </g>
      )
    case 'lightning':
      return (
        <g>
          <Cloudlet cx={50} cy={40} />
          <path
            d="M52 58 L42 74 L50 74 L46 88 L62 68 L53 68 L58 58 Z"
            fill="currentColor"
            fillOpacity="0.85"
            className="animate-pulse"
          />
        </g>
      )
    case 'fog':
      return (
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.6">
          <line x1="26" y1="40" x2="74" y2="40" />
          <line x1="30" y1="52" x2="70" y2="52" />
          <line x1="24" y1="64" x2="68" y2="64" />
          <line x1="32" y1="76" x2="76" y2="76" />
        </g>
      )
    case 'wind':
      return (
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.75">
          <path d="M22 42 H60 a7 7 0 1 0 -7 -7" />
          <path d="M22 56 H72 a7 7 0 1 1 -7 7" />
          <path d="M22 70 H52 a6 6 0 1 0 -6 -6" />
        </g>
      )
    case 'hail':
      return (
        <g>
          <Cloudlet cx={50} cy={42} />
          <g fill="currentColor" opacity="0.85" className="animate-pulse">
            <circle cx="40" cy="70" r="3" />
            <circle cx="52" cy="78" r="3" />
            <circle cx="62" cy="68" r="3" />
          </g>
        </g>
      )
    default: {
      // Exhaustive guard — fails to compile if a new WeatherGlyph is added.
      glyph satisfies never
      return null
    }
  }
}

// ── Readout atom ──────────────────────────────────────────────────────────────

interface ReadoutProps {
  readonly icon: ReactNode
  readonly label: string
  readonly value: string
}

function Readout({ icon, label, value }: ReadoutProps): ReactNode {
  return (
    <div className="flex items-center gap-1.5 text-xs text-foreground-subtle" title={label}>
      <span className="inline-flex text-foreground-subtle" aria-hidden="true">
        {icon}
      </span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

// ── Hero ────────────────────────────────────────────────────────────────────

/**
 * WeatherHeroCard — read-only weather panel for the device-detail hero.
 *
 * Bespoke state-tinted sky scene + a large temperature readout +
 * humidity / wind-speed (with a bearing arrow) / pressure readouts.
 * Pure — no controls (the cap is read-only).
 */
export function WeatherHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { slice } = useWeather(trpc, deviceId)
  if (slice === undefined) return null

  const meta = weatherConditionMeta(slice.condition, t)
  const tint = weatherTint(slice.condition)
  const unit = slice.temperatureUnit ?? '°'

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-6">
        <WeatherScene glyph={meta.glyph} tint={tint} />

        <div className="flex flex-col gap-3 flex-1">
          {/* Temperature — large readable label */}
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {slice.temperature !== null ? Math.round(slice.temperature) : '—'}
            </span>
            <span className="text-base text-foreground-subtle">{unit}</span>
            <span className="text-xs text-foreground-subtle ml-2 capitalize">{meta.label}</span>
          </div>

          {/* Readouts — humidity / wind / pressure */}
          <div className="flex flex-col gap-1.5">
            {slice.humidity !== null && (
              <Readout
                icon={<Droplets className="h-3.5 w-3.5" />}
                label={t('uiLibrary.weatherControl.humidity', 'Humidity')}
                value={`${Math.round(slice.humidity)}%`}
              />
            )}
            {slice.windSpeed !== null && (
              <Readout
                icon={
                  slice.windBearing !== null ? (
                    <Navigation
                      className="h-3.5 w-3.5"
                      style={{ transform: `rotate(${slice.windBearing}deg)` }}
                    />
                  ) : (
                    <Wind className="h-3.5 w-3.5" />
                  )
                }
                label={t('uiLibrary.weatherControl.wind', 'Wind')}
                value={`${Math.round(slice.windSpeed)} ${slice.windSpeedUnit ?? ''}`.trim()}
              />
            )}
            {slice.pressure !== null && (
              <Readout
                icon={<Gauge className="h-3.5 w-3.5" />}
                label={t('uiLibrary.weatherControl.pressure', 'Pressure')}
                value={`${Math.round(slice.pressure)} ${slice.pressureUnit ?? ''}`.trim()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
