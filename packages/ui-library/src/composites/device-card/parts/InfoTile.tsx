import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { CardGlyph } from '../icons'
import { CardIcon } from './CardIcon'

export type InfoTileTone = 'default' | 'warning' | 'danger' | 'success'

export interface InfoTileProps {
  readonly glyph?: CardGlyph
  /** The small word (a door sensor's name, "Humidity"); omitted when the value says it all. */
  readonly label?: string
  /** Null when not reported yet: "—". */
  readonly value: string | null
  readonly tone?: InfoTileTone
  /**
   * `stack`: glyph over the value, the label under it (a door contact beside a
   * lock). `side`: glyph left, label over the value (a weather reading). `row`:
   * one line, glyph and label left, the value right (a linked leak sensor).
   */
  readonly layout?: 'stack' | 'side' | 'row'
  readonly testId?: string
}

const TONE: Readonly<Record<InfoTileTone, string>> = {
  default: 'bg-surface-hover text-foreground',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-surface-hover text-foreground',
}

const VALUE_TONE: Readonly<Record<InfoTileTone, string>> = {
  default: '',
  warning: '',
  danger: '',
  success: 'text-success',
}

/** A read-only tile in a scene: something the device knows, never a control. */
export function InfoTile({
  glyph,
  label,
  value,
  tone = 'default',
  layout = 'stack',
  testId,
}: InfoTileProps): ReactElement {
  const shown = value ?? '—'
  if (layout === 'row') {
    return (
      <div
        data-testid={testId}
        data-tone={tone}
        className={cn(
          'grid w-full max-w-70 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs',
          TONE[tone === 'danger' ? 'default' : tone],
        )}
      >
        {glyph === undefined ? <span /> : <CardIcon glyph={glyph} />}
        <b className="truncate font-medium text-foreground">{label}</b>
        <small
          className={cn(
            'font-semibold',
            tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : '',
          )}
        >
          {shown}
        </small>
      </div>
    )
  }
  if (layout === 'side') {
    return (
      <div
        data-testid={testId}
        className={cn(
          'grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 rounded-lg px-2 py-1.5 text-left',
          TONE[tone],
        )}
      >
        {glyph === undefined ? <span /> : <CardIcon glyph={glyph} />}
        <span className="grid min-w-0">
          {label === undefined ? null : (
            <small className="truncate text-xs text-foreground-muted">{label}</small>
          )}
          <b className="text-sm font-semibold tabular-nums break-words">{shown}</b>
        </span>
      </div>
    )
  }
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'grid min-w-23 max-w-30 justify-items-center gap-0.5 rounded-xl px-2.5 py-2 text-center text-xs',
        TONE[tone],
      )}
    >
      {glyph === undefined ? null : <CardIcon glyph={glyph} />}
      <b className={cn('font-semibold', VALUE_TONE[tone])}>{shown}</b>
      {label === undefined ? null : <small className="text-foreground-muted">{label}</small>}
    </div>
  )
}
