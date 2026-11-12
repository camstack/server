/**
 * The simple sensor's scene (card wave, phase 1): its ONE reading, big, with the
 * quantity's icon beside it, over an animation that says what the number means.
 * Every value comes from the model's `measurement`; the scene only paints it.
 *
 * The state corner ("HOT · 2m ago ›") opens the device's history; a trend line
 * sits under the value when the history has the series. Under
 * `prefers-reduced-motion` the backdrop stands still (HERO_SCENE_CSS).
 */
import { type HeroMeasurement, type HeroMeasurementReading, isNotReported } from '@camstack/types'
import { ChevronRight } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { cn } from '../../lib/cn'
import { formatLastSeen, MIN_PLAUSIBLE_TIMESTAMP_MS } from '../../lib/format-last-seen'
import { preferenceForQuantity } from '../../lib/unit-preferences'
import { Button } from '../../primitives/button'
import { Sparkline, type SparklinePoint } from '../charts/Sparkline'
import { useHistoryReads } from '../device-history/use-device-history'
import { HISTORY_WINDOW_MS } from '../device-history/history-window'
import { useDisplayIconResolver } from '../icon-glyphs'
import { SceneBackdrop } from '../hero-scene/backdrops'
import { HERO_SCENE_CSS } from '../hero-scene/hero-scene-css'
import { TONE_CLASS } from '../hero-scene/scene-map'
import type { SceneSpeed, SceneVisual } from '../hero-scene/types'
import { useCardDisplaySubject } from './card-display-subject'
import { type HeroLang, pickText } from './hero-model-view'
import { useMeasurementText } from './measurement-display'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The fewest points a trend line is drawn from: one point is not a trend. */
const TREND_MIN_POINTS = 2

function powerSpeed(level: number): SceneSpeed {
  if (level < 0.15) return 'slow'
  return level < 0.5 ? 'normal' : 'fast'
}

/**
 * The backdrop a measurement moves with; `null` = the scene stands still (a mild
 * temperature, a closed contact, a text state).
 */
export function measurementVisual(m: HeroMeasurement): SceneVisual | null {
  const still = { tone: m.tone, speed: 'normal', dim: false } as const
  switch (m.quantity) {
    case 'temperature':
      if (m.band === 'hot') return { ...still, kind: 'heat' }
      if (m.band === 'cold') return { ...still, kind: 'drop', speed: 'slow' }
      return null
    case 'humidity':
      return { ...still, kind: 'fall', speed: 'slow' }
    case 'power': {
      const level = m.level ?? 0
      return { ...still, kind: 'wire', speed: powerSpeed(level), dim: level <= 0 }
    }
    case 'contact':
      return (m.level ?? 0) > 0 ? { ...still, kind: 'ripple' } : null
    case 'text':
      return null
  }
}

/** "for 12 min": how long a state has held, for a `changed` measurement. */
function heldForText(since: number, t: UiTextFn): string | null {
  if (since < MIN_PLAUSIBLE_TIMESTAMP_MS) return null
  const held = Math.max(0, Date.now() - since)
  if (held < HOUR_MS) {
    return t('uiLibrary.measurement.forMinutes', 'for {{count}} min', {
      count: Math.max(1, Math.floor(held / MINUTE_MS)),
    })
  }
  if (held < DAY_MS) {
    return t('uiLibrary.measurement.forHours', 'for {{count}} h', {
      count: Math.floor(held / HOUR_MS),
    })
  }
  return t('uiLibrary.measurement.forDays', 'for {{count}} d', {
    count: Math.floor(held / DAY_MS),
  })
}

export function measurementSinceText(m: HeroMeasurement, t: UiTextFn): string | null {
  if (m.since === null) return null
  return m.sinceKind === 'changed' ? heldForText(m.since, t) : formatLastSeen(m.since, t)
}

interface StateCornerProps {
  readonly measurement: HeroMeasurement
  readonly lang: HeroLang
  readonly onOpenHistory: (() => void) | undefined
}

function StateCorner({ measurement, lang, onOpenHistory }: StateCornerProps): ReactNode {
  const t = useUiText()
  const since = measurementSinceText(measurement, t)
  // Not reported yet: the value already reads "—"; the corner adds nothing.
  if (since === null && isNotReported(measurement.word)) return null
  const text = (
    <>
      <span className="font-semibold uppercase tracking-wide">
        {pickText(measurement.word, lang)}
      </span>
      {since === null ? null : (
        <span className="font-normal text-foreground-muted">{` · ${since}`}</span>
      )}
    </>
  )
  return (
    <div data-testid="measurement-state" className="absolute left-2 top-2 z-20 text-xs">
      {onOpenHistory === undefined ? (
        <span className="inline-flex px-2 py-1">{text}</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-2 py-1 text-xs text-current"
          aria-label={t('uiLibrary.measurement.openHistory', 'Open history')}
          onClick={onOpenHistory}
        >
          {text}
          <ChevronRight className="size-3.5 text-foreground-muted" aria-hidden />
        </Button>
      )}
    </div>
  )
}

interface TrendProps {
  readonly deviceId: number
  readonly historyKey: string
  readonly label: string
  /** The series is in this reading's base unit; the tooltip converts it like the value. */
  readonly reading: HeroMeasurementReading
}

/** The last day of the measurement's series; nothing until the read answers with a line. */
function Trend({ deviceId, historyKey, label, reading }: TrendProps): ReactNode {
  const unitPreferences = useUnitPreferences()
  const window = useMemo(() => {
    const to = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS
    return { from: to - HISTORY_WINDOW_MS['24h'], to }
  }, [])
  const items = useMemo(() => [{ deviceId, key: historyKey }], [deviceId, historyKey])
  const reads = useHistoryReads(items, window, false)
  if (reads.status !== 'ok') return null
  const entry = [...reads.data.current.values()][0]
  if (entry === undefined || !entry.ok) return null
  const points: SparklinePoint[] = (entry.result.series[0]?.points ?? []).map((p) => ({
    x: p.t,
    v: p.mean ?? p.last,
  }))
  if (points.filter((p) => p.v !== null).length < TREND_MIN_POINTS) return null
  return (
    <span data-testid="measurement-trend" className="flex justify-center">
      <Sparkline
        points={points}
        ariaLabel={label}
        token="primary"
        quantity={reading.quantity}
        displayPreference={preferenceForQuantity(unitPreferences, reading.quantity)}
        zeroBased={false}
        height={36}
        widthClassName="w-48 @lg:w-64"
      />
    </span>
  )
}

interface QuantityIconProps {
  readonly icon: string
}

function QuantityIcon({ icon }: QuantityIconProps): ReactNode {
  const resolve = useDisplayIconResolver()
  const Glyph = resolve(icon)
  return Glyph === undefined ? null : <Glyph className="size-10 shrink-0" aria-hidden />
}

export interface MeasurementSceneProps {
  readonly measurement: HeroMeasurement
  readonly lang: HeroLang
  readonly deviceId: number
  /** Opens the device's history; absent = the state corner is only read and no trend is drawn. */
  readonly onOpenHistory?: () => void
}

/**
 * The scene of a sensor that measures one thing. Tall and stacked in a narrow card;
 * in a wide one (the desktop page) lower, with the value and the trend side by side.
 */
export function MeasurementScene({
  measurement,
  lang,
  deviceId,
  onOpenHistory,
}: MeasurementSceneProps): ReactNode {
  const visual = measurementVisual(measurement)
  const text = useMeasurementText(measurement, lang, useCardDisplaySubject())
  const value = text.value
  return (
    <div
      data-testid="measurement-scene"
      data-quantity={measurement.quantity}
      data-band={measurement.band ?? undefined}
      className={cn(
        '@container relative w-full overflow-hidden rounded-xl border border-current/40 bg-surface/30',
        TONE_CLASS[measurement.tone],
      )}
    >
      <style>{HERO_SCENE_CSS}</style>
      {visual === null ? null : <SceneBackdrop visual={visual} />}
      <StateCorner measurement={measurement} lang={lang} onOpenHistory={onOpenHistory} />
      <div className="relative z-10 flex h-64 flex-col items-center justify-center gap-3 px-4 pt-6 @lg:h-48 @lg:flex-row @lg:gap-10">
        <div className="flex min-w-0 max-w-full items-center gap-3">
          {measurement.icon === null ? null : <QuantityIcon icon={measurement.icon} />}
          <div className="flex min-w-0 items-baseline gap-1 text-foreground">
            <span
              data-testid="measurement-value"
              className={cn(
                'min-w-0 font-semibold leading-none tabular-nums',
                measurement.quantity === 'text' ? 'break-words text-center text-3xl' : 'text-6xl',
              )}
            >
              {value}
            </span>
            {text.unit === null ? null : (
              <span className="text-xl font-semibold text-foreground-muted">{text.unit}</span>
            )}
          </div>
        </div>
        {measurement.historyKey === null ||
        measurement.reading === null ||
        onOpenHistory === undefined ? null : (
          <Trend
            deviceId={deviceId}
            historyKey={measurement.historyKey}
            label={value}
            reading={measurement.reading}
          />
        )}
      </div>
    </div>
  )
}
