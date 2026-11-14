import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { ValueChip } from '../parts/ValueChip'

let makeRow!: (
  key: string,
  kind: BottomRowKind,
  label: string | undefined,
  node: ReactElement,
) => BottomRow

export type BottomRowKind = 'selector' | 'pills' | 'stats' | 'buttons' | 'slider' | 'text' | 'block'

/**
 * One horizontal row of a scene's bottom area: n rows, each of one kind, drawn
 * by the one renderer in `SceneGrid`. A `BottomRow` is made only by the
 * `row*` factories below, so a scene cannot hand the bottom a loose node.
 * `label` is an optional short caption above the row.
 */
export class BottomRow {
  private constructor(
    readonly key: string,
    readonly kind: BottomRowKind,
    readonly label: string | undefined,
    readonly node: ReactElement,
  ) {}

  static {
    // The only way to build a row is `makeRow`, below; the constructor stays private.
    makeRow = (key, kind, label, node) => new BottomRow(key, kind, label, node)
  }
}

interface RowBase {
  /** A short caption over the row ("Battery"), one or two words. */
  readonly label?: string
}

export interface RowSelectorProps extends RowBase {
  /** The selector or menu button itself. */
  readonly control: ReactElement
}

/** A selector, dropdown or segmented choice, on a row of its own. */
export function rowSelector(key: string, props: RowSelectorProps): BottomRow {
  return makeRow(key, 'selector', props.label, props.control)
}

export interface RowPill {
  readonly id: string
  readonly text: string
  readonly tone?: 'default' | 'danger'
  readonly testId?: string
}

export interface RowPillsProps extends RowBase {
  readonly pills: readonly RowPill[]
  readonly testId?: string
}

/** Short chips that wrap: facts that carry no number to compare. */
export function rowPills(key: string, props: RowPillsProps): BottomRow {
  return makeRow(
    key,
    'pills',
    props.label,
    <ul data-testid={props.testId} className="flex flex-wrap justify-center gap-1.5">
      {props.pills.map((pill) => (
        <li key={pill.id}>
          <ValueChip tone={pill.tone} data-testid={pill.testId}>
            {pill.text}
          </ValueChip>
        </li>
      ))}
    </ul>,
  )
}

export interface RowStat {
  readonly id: string
  readonly name: string
  readonly value: string
}

export interface RowStatsProps extends RowBase {
  /** Up to four: they share the row's width equally. */
  readonly stats: readonly RowStat[]
  readonly testId?: string
  /** Test id of each cell. */
  readonly cellTestId?: string
}

/** Name over value, up to four cells sharing a row: the compact way to show readings. */
export function rowStats(key: string, props: RowStatsProps): BottomRow {
  return makeRow(
    key,
    'stats',
    props.label,
    <ul
      data-testid={props.testId}
      className="grid w-full grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1.5"
    >
      {props.stats.map((stat) => (
        <li
          key={stat.id}
          data-testid={props.cellTestId}
          className="flex min-w-0 flex-col items-center rounded-lg bg-surface-hover px-1.5 py-1 text-center text-xs text-foreground-muted"
        >
          <span className="max-w-full truncate">{stat.name}</span>
          <span className="max-w-full truncate font-semibold tabular-nums text-foreground">
            {stat.value}
          </span>
        </li>
      ))}
    </ul>,
  )
}

export interface RowButtonsProps extends RowBase {
  /** Buttons, armed buttons or menus, drawn side by side. */
  readonly buttons: readonly ReactElement[]
}

/** Commands side by side on a row. */
export function rowButtons(key: string, props: RowButtonsProps): BottomRow {
  return makeRow(
    key,
    'buttons',
    props.label,
    <div className="flex flex-wrap items-center justify-center gap-2">
      {props.buttons.map((button, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of buttons, never reordered
        <span key={i} className="contents">
          {button}
        </span>
      ))}
    </div>,
  )
}

export interface RowSliderProps extends RowBase {
  /** A `HorizontalSlider`. */
  readonly slider: ReactElement
}

/** One horizontal track across the card. */
export function rowSlider(key: string, props: RowSliderProps): BottomRow {
  return makeRow(key, 'slider', props.label, <div className="w-full">{props.slider}</div>)
}

export interface RowTextProps extends RowBase {
  readonly text: string
  readonly tone?: 'muted' | 'warning' | 'danger'
  readonly testId?: string
}

const TEXT_TONE: Readonly<Record<NonNullable<RowTextProps['tone']>, string>> = {
  muted: 'text-foreground-muted',
  warning: 'text-warning',
  danger: 'text-danger',
}

/** A sentence or a short fact on a row. */
export function rowText(key: string, props: RowTextProps): BottomRow {
  return makeRow(
    key,
    'text',
    props.label,
    <p
      data-testid={props.testId}
      className={cn('break-words text-center text-xs', TEXT_TONE[props.tone ?? 'muted'])}
    >
      {props.text}
    </p>,
  )
}

export interface RowBlockProps extends RowBase {
  /** A composed control the other kinds cannot express (a code pad, a vocabulary list). */
  readonly content: ReactElement
}

/** The escape hatch: one composed block. Prefer a typed row. */
export function rowBlock(key: string, props: RowBlockProps): BottomRow {
  return makeRow(key, 'block', props.label, props.content)
}
