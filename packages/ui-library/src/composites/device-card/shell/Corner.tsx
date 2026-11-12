import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { Button } from '../../../primitives/button'
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

export const CORNER_CLASS =
  'absolute z-10 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs'

export interface CornerProps {
  readonly place: CornerPlace
  readonly className?: string
  readonly children: ReactNode
  readonly testId?: string
}

/** One of the scene's four corners. */
export function Corner({ place, className, children, testId }: CornerProps): ReactElement {
  return (
    <span
      data-corner={place}
      data-testid={testId}
      className={cn(CORNER_CLASS, PLACE[place], className)}
    >
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

/** Top-left: what the device is doing, and since when. */
export function StateCorner({ state, onOpenHistory }: StateCornerProps): ReactElement {
  const t = useUiText()
  const body = (
    <>
      <span className={cn('font-semibold uppercase tracking-wide', TONE_TEXT[state.tone])}>
        {state.label}
      </span>
      {state.since === null ? null : (
        <small className="text-foreground-muted">· {state.since}</small>
      )}
    </>
  )
  if (onOpenHistory === undefined) {
    return (
      <Corner place="tl" testId="dc-state">
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
      className={cn(CORNER_CLASS, PLACE.tl, 'hover:bg-surface-hover')}
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
          CORNER_CLASS,
          PLACE.tr,
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
export function BatteryCorner({ level }: { readonly level: number }): ReactElement {
  const low = level < BATTERY_LOW_PERCENT
  return (
    <Corner
      place="bl"
      testId="dc-battery"
      className={cn('tabular-nums', low ? 'text-danger' : 'text-foreground-muted')}
    >
      <CardIcon glyph={low ? 'batteryLow' : 'battery'} className="h-3.5 w-3.5 text-success" />
      {Math.round(level)}%
    </Corner>
  )
}

/** Bottom-right: opens the device's remote. */
export function RemoteCorner({ onOpen }: { readonly onOpen: () => void }): ReactElement {
  const t = useUiText()
  return (
    <Button
      type="button"
      variant="unstyled"
      data-corner="br"
      data-testid="dc-remote"
      aria-label={t('uiLibrary.deviceCard.remote', 'Remote')}
      onClick={onOpen}
      className={cn(
        CORNER_CLASS,
        PLACE.br,
        'border border-border bg-surface px-1.5 py-1 text-foreground hover:bg-surface-hover',
      )}
    >
      <CardIcon glyph="remote" className="h-3.5 w-3.5" />
    </Button>
  )
}
