import { type Context, createContext, type ReactElement, type ReactNode, useContext } from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { Button } from '../../../primitives/button'
import { formatNumeric } from '../../../lib/format-numeric'
import {
  BATTERY_BADGE_LOW_KEY,
  BATTERY_BADGE_NORMAL_KEY,
  binaryBatteryIsLow,
} from '../../binary-battery'
import { CardIcon } from '../parts/CardIcon'
import { KeyValue } from '../parts/KeyValue'
import { BATTERY_LOW_PERCENT, type CardPower, type CardState, type CardTone } from './model'
import { usePopover } from './use-popover'

export type CornerPlace = 'tl' | 'tr' | 'bl' | 'br'

const PLACE: Readonly<Record<CornerPlace, string>> = {
  tl: 'left-2 top-2',
  tr: 'right-2 top-2',
  bl: 'bottom-2 left-2',
  br: 'bottom-2 right-2',
}

const CORNER_BASE =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-0.5 text-xs'

export const CORNER_CLASS: string = `absolute z-10 ${CORNER_BASE}`

/**
 * Where the indicators sit: `overlay` (default) pins each to a corner of the
 * scene; `frame` lays them out in a row of the card's frame, so a scene that
 * must stay unobstructed (a camera's player) carries nothing on top of it.
 */
export type CornerLayout = 'overlay' | 'frame'

const CornerLayoutContext: Context<CornerLayout> = createContext<CornerLayout>('overlay')

export const CornerLayoutProvider: Context<CornerLayout>['Provider'] = CornerLayoutContext.Provider

function useCornerClass(place: CornerPlace): string {
  return useContext(CornerLayoutContext) === 'frame' ? CORNER_BASE : cn(CORNER_CLASS, PLACE[place])
}

export interface CornerProps {
  readonly place: CornerPlace
  readonly className?: string
  readonly children: ReactNode
  readonly testId?: string
}

/** One of the scene's four corners. */
export function Corner({ place, className, children, testId }: CornerProps): ReactElement {
  const placed = useCornerClass(place)
  return (
    <span data-corner={place} data-testid={testId} className={cn(placed, className)}>
      {children}
    </span>
  )
}

const TONE_TEXT: Readonly<Record<CardTone, string>> = {
  primary: 'text-primary',
  info: 'text-info',
  warning: 'text-warning',
  success: 'text-success',
  danger: 'text-danger',
  muted: 'text-foreground-muted',
}

export function cardToneClass(tone: CardTone): string {
  return TONE_TEXT[tone]
}

export interface StateCornerProps {
  readonly state: CardState
  /** Present when the device has history: the corner opens it. */
  readonly onOpenHistory?: () => void
}

/** The state corner stays on one line inside the scene; a long "since" is cut, never wrapped. */
const STATE_FIT = 'max-w-[calc(100%-1rem)]'

/** Top-left: what the device is doing, and since when. */
export function StateCorner({ state, onOpenHistory }: StateCornerProps): ReactElement {
  const t = useUiText()
  const placed = useCornerClass('tl')
  const body = (
    <>
      {state.label === '' ? null : (
        <span
          className={cn('shrink-0 font-semibold uppercase tracking-wide', TONE_TEXT[state.tone])}
        >
          {state.label}
        </span>
      )}
      {state.since === null ? null : (
        <small className="min-w-0 truncate text-foreground-muted">· {state.since}</small>
      )}
    </>
  )
  if (onOpenHistory === undefined) {
    return (
      <Corner place="tl" testId="dc-state" className={STATE_FIT}>
        {body}
      </Corner>
    )
  }
  return (
    <Button
      type="button"
      variant="unstyled"
      data-corner="tl"
      data-testid="dc-state"
      aria-label={t('uiLibrary.deviceCard.openHistory', 'Open the history')}
      onClick={onOpenHistory}
      className={cn(placed, STATE_FIT, 'hover:bg-surface-hover')}
    >
      {body}
      <CardIcon glyph="open" className="h-3 w-3 text-primary" />
    </Button>
  )
}

/** Top-right: the power drawn now; a press lists the other electrical readings. */
export function PowerCorner({ power }: { readonly power: CardPower }): ReactElement {
  const t = useUiText()
  const pop = usePopover()
  const placed = useCornerClass('tr')
  const drawing = (power.watts ?? 0) > 0
  const hasDetails = power.details.length > 0
  return (
    <div ref={pop.rootRef} data-corner="tr" data-testid="dc-power">
      <Button
        type="button"
        variant="unstyled"
        disabled={!hasDetails}
        aria-expanded={pop.open}
        aria-label={t('uiLibrary.deviceCard.powerDetails', 'Power details')}
        onClick={pop.toggle}
        className={cn(
          placed,
          'font-semibold tabular-nums',
          drawing ? 'bg-primary/10 text-primary' : 'text-foreground-muted',
        )}
      >
        <CardIcon glyph="watt" className="h-3 w-3" />
        {power.watts === null ? '—' : `${Math.round(power.watts)} W`}
        {hasDetails ? <CardIcon glyph="info" className="h-3 w-3 opacity-70" /> : null}
      </Button>
      {pop.open ? (
        <div
          role="dialog" // ui-check-ok: an anchored in-card popover (card anatomy), not a modal
          data-testid="dc-power-pop"
          className="absolute right-2 top-9 z-20 flex min-w-44 flex-col gap-1.5 rounded-xl border border-border bg-surface p-3 shadow-lg"
        >
          {power.details.map((d) => (
            <div key={d.id} className={cn(d.group === true && 'border-t border-border pt-1.5')}>
              <KeyValue label={d.label} value={d.value} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Bottom-left: the device's own battery. */
export function BatteryCorner({
  level,
  binary = false,
  voltage = null,
  label,
  shifted = false,
}: {
  /** Null: only a voltage is known — no state is drawn, never a flat 0 %. */
  readonly level: number | null
  /** A low/ok source: `level` is a stand-in, so the state is named, not the percent. */
  readonly binary?: boolean
  /** Volts, drawn beside the state when known. */
  readonly voltage?: number | null
  readonly label?: string
  /** The motion corner holds the corner's start: the battery sits beside it. */
  readonly shifted?: boolean
}): ReactElement {
  const t = useUiText()
  const low = level !== null && (binary ? binaryBatteryIsLow(level) : level < BATTERY_LOW_PERCENT)
  const state =
    label ??
    (level === null
      ? null
      : binary
        ? low
          ? t(BATTERY_BADGE_LOW_KEY, 'Low')
          : t(BATTERY_BADGE_NORMAL_KEY, 'Normal')
        : `${Math.round(level)}%`)
  const volts = voltage === null ? null : `${formatNumeric(voltage, 1)} V`
  return (
    <Corner
      place="bl"
      testId="dc-battery"
      className={cn(
        'tabular-nums',
        low ? 'text-danger' : 'text-foreground-muted',
        shifted && 'left-11',
      )}
    >
      <CardIcon
        glyph={low ? 'batteryLow' : 'battery'}
        className={cn(
          'h-3.5 w-3.5',
          low ? 'text-danger' : level === null ? 'text-foreground-muted' : 'text-success',
        )}
      />
      {state}
      {state !== null && volts !== null ? <span aria-hidden="true">·</span> : null}
      {volts}
    </Corner>
  )
}

/** Bottom-right: opens the device's remote. */
export function RemoteCorner({ onOpen }: { readonly onOpen: () => void }): ReactElement {
  const t = useUiText()
  const placed = useCornerClass('br')
  return (
    <Button
      type="button"
      variant="unstyled"
      data-corner="br"
      data-testid="dc-remote"
      aria-label={t('uiLibrary.deviceCard.remote', 'Remote')}
      onClick={onOpen}
      className={cn(
        placed,
        'border border-border bg-surface px-1.5 py-1 text-foreground hover:bg-surface-hover',
      )}
    >
      <CardIcon glyph="remote" className="h-3.5 w-3.5" />
    </Button>
  )
}

export interface MotionCornerProps {
  /** Null: not read yet. Drawn neither on nor off; a tap still sets it on. */
  readonly on: boolean | null
  readonly pending: boolean
  /** Gating: a blocked card may not be commanded. */
  readonly blocked: boolean
  readonly onToggle: (enabled: boolean) => void
}

/** Bottom-left: the "on motion" toggle, an icon with no text. */
export function MotionCorner({ on, pending, blocked, onToggle }: MotionCornerProps): ReactElement {
  const t = useUiText()
  const placed = useCornerClass('bl')
  return (
    <Button
      type="button"
      variant="unstyled"
      data-corner="bl"
      data-testid="dc-motion"
      aria-pressed={on === null ? 'mixed' : on}
      aria-busy={pending}
      aria-label={t('uiLibrary.deviceCard.onMotion', 'On motion')}
      title={
        on === null
          ? t('uiLibrary.deviceCard.onMotionUnknown', 'On motion: not read from the camera yet')
          : t('uiLibrary.deviceCard.onMotion', 'On motion')
      }
      data-state={on === null ? 'unknown' : on ? 'on' : 'off'}
      disabled={pending || blocked}
      onClick={() => onToggle(on !== true)}
      className={cn(
        placed,
        'border px-1.5 py-1 transition-colors disabled:pointer-events-none',
        on === true
          ? 'border-primary bg-primary/10 text-primary'
          : on === null
            ? 'border-dashed border-border text-foreground-subtle'
            : 'border-border text-foreground-muted',
        blocked && !pending && 'opacity-45',
      )}
    >
      <CardIcon
        glyph={pending ? 'pending' : 'motion'}
        className={cn('h-3.5 w-3.5', pending && 'animate-spin')}
      />
    </Button>
  )
}
