/**
 * The DOM half every chart of the family shares: the title, the cursor
 * readout, the legend with direct values, the actions slot (a ⋯ menu) and the
 * accessible summary. The plot itself is canvas; everything a reader or a
 * screen reader needs to IDENTIFY a series is here, in text tokens — a series
 * colour only ever sits on a swatch beside the text.
 *
 * One series: no legend box — the title names it, the value sits beside it.
 * Two or more: a legend is always present and every entry carries its value.
 */
import { type JSX, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { swatchFillClass, swatchLineClass, type ChartSwatchToken } from './chart-palette'

export interface ChartLegendEntry {
  readonly id: string
  readonly label: string
  /** The swatch colour: the series' token. */
  readonly token: ChartSwatchToken
  /** The swatch is drawn as a dashed line (a compare series, or a ninth+ series). */
  readonly dashed?: boolean
  /** The value at the cursor (or the latest); `undefined` hides it. */
  readonly value?: string
  /** A secondary entry (a compare period): recessive text. */
  readonly muted?: boolean
}

export interface ChartFrameProps {
  readonly title: string
  /** Controls at the right of the title (a ⋯ menu). */
  readonly actions?: ReactNode
  /** The instant the readout shows, when the cursor is on the plot. */
  readonly readoutTime?: string | null
  readonly legend: readonly ChartLegendEntry[]
  /** One sentence a screen reader gets instead of the canvas. */
  readonly summary: string
  /** Text under the legend (a total, what one bar covers). */
  readonly footer?: ReactNode
  /** Rendered INSTEAD of the plot (empty or not-yet-answered). */
  readonly placeholder?: ReactNode
  /** Interactive content tied to the plot (bucket buttons), kept OUTSIDE its `role="img"`. */
  readonly controls?: ReactNode
  readonly className?: string
  readonly children?: ReactNode
}

export function ChartFrame({
  title,
  actions,
  readoutTime,
  legend,
  summary,
  footer,
  placeholder,
  controls,
  className,
  children,
}: ChartFrameProps): JSX.Element {
  const single = legend.length === 1 ? legend[0] : undefined
  return (
    <figure className={cn('min-w-0 m-0', className)} data-chart-frame="">
      <div className="flex items-baseline justify-between gap-2 mb-1 min-w-0">
        <figcaption className="text-[10px] uppercase tracking-wider text-foreground-subtle truncate min-w-0">
          {title}
        </figcaption>
        <div className="flex items-center gap-2 shrink-0">
          {readoutTime && (
            <span className="text-[10px] tabular-nums text-foreground-subtle">{readoutTime}</span>
          )}
          {single?.value !== undefined && placeholder === undefined && (
            <LegendValue entry={single} />
          )}
          {actions}
        </div>
      </div>
      {placeholder ?? (
        <div role="img" aria-label={summary} className="min-w-0">
          {children}
        </div>
      )}
      {placeholder === undefined && controls}
      <p className="sr-only">{summary}</p>
      {legend.length > 1 && placeholder === undefined && (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 list-none p-0 m-0">
          {legend.map((entry) => (
            <li key={entry.id} className="min-w-0">
              <LegendItem entry={entry} />
            </li>
          ))}
        </ul>
      )}
      {footer && <div className="mt-1 text-[10px] text-foreground-subtle">{footer}</div>}
    </figure>
  )
}

/** The swatch: a filled square, or a dashed bar for a dashed series. */
export function ChartSwatch({
  token,
  dashed,
}: {
  readonly token: ChartSwatchToken
  readonly dashed?: boolean
}): JSX.Element {
  return dashed ? (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-0 w-3 border-t-2 border-dashed shrink-0',
        swatchLineClass(token),
      )}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 rounded-[2px] shrink-0', swatchFillClass(token))}
    />
  )
}

function LegendItem({ entry }: { readonly entry: ChartLegendEntry }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] min-w-0',
        entry.muted ? 'text-foreground-subtle' : 'text-foreground-muted',
      )}
    >
      <ChartSwatch token={entry.token} dashed={entry.dashed} />
      <span className="truncate">{entry.label}</span>
      {entry.value !== undefined && (
        <span className="tabular-nums text-foreground">{entry.value}</span>
      )}
    </span>
  )
}

function LegendValue({ entry }: { readonly entry: ChartLegendEntry }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-foreground">
      <ChartSwatch token={entry.token} dashed={entry.dashed} />
      {entry.value}
    </span>
  )
}

/** The plot-sized box for an empty or pending chart: a dashed outline and one line of text. */
export function ChartPlaceholder({
  message,
  height,
}: {
  readonly message: string
  readonly height: 'sm' | 'md' | 'lg'
}): JSX.Element {
  const h = height === 'sm' ? 'h-8' : height === 'md' ? 'h-24' : 'h-40'
  return (
    <div
      className={cn(
        h,
        'flex items-center justify-center rounded border border-dashed border-border text-[10px] text-foreground-subtle text-center px-2',
      )}
    >
      {message}
    </div>
  )
}
