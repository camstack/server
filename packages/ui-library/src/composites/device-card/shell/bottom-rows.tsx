import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { CardGlyph } from '../icons'
import { CardButton } from '../parts/CardButton'
import { CardIcon } from '../parts/CardIcon'
import { CodePad } from '../parts/CodePad'
import { InfoTile, type InfoTileTone } from '../parts/InfoTile'
import { LevelRow } from '../parts/LevelRow'
import { SwitchTimer } from '../parts/SwitchTimer'
import type { SwitchTimerActions, SwitchTimerModel } from '../parts/switch-timer-model'
import { ValueChip } from '../parts/ValueChip'
import { ValueEntry, type ValueEntryProps } from '../parts/ValueEntry'

let makeRow!: (
  key: string,
  kind: BottomRowKind,
  label: string | undefined,
  node: ReactElement,
) => BottomRow

export type BottomRowKind =
  | 'selector'
  | 'pills'
  | 'stats'
  | 'buttons'
  | 'slider'
  | 'text'
  | 'lines'
  | 'list'
  | 'levels'
  | 'timer'
  | 'entry'
  | 'codepad'
  | 'stepper'

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
  readonly tone?: 'default' | 'warning'
  readonly testId?: string
}

const STATS_COLUMNS: Readonly<Record<number, string>> = {
  0: 'grid-cols-1',
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
}

export interface RowStatsProps extends RowBase {
  /** Up to four: they share the row's width equally (a fifth would wrap, so split the row). */
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
      className={cn('grid w-full gap-1.5', STATS_COLUMNS[Math.min(props.stats.length, 4)])}
    >
      {props.stats.map((stat) => (
        <li
          key={stat.id}
          data-testid={stat.testId ?? props.cellTestId}
          className="flex min-w-0 flex-col items-center rounded-lg bg-surface-hover px-1.5 py-1 text-center text-xs text-foreground-muted"
        >
          <span className="line-clamp-2 max-w-full break-words text-[11px] leading-tight">
            {stat.name}
          </span>
          <span
            className={cn(
              'max-w-full truncate font-semibold tabular-nums',
              stat.tone === 'warning' ? 'text-warning' : 'text-foreground',
            )}
          >
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
  readonly testId?: string
}

/** Commands side by side on a row. */
export function rowButtons(key: string, props: RowButtonsProps): BottomRow {
  return makeRow(
    key,
    'buttons',
    props.label,
    <div
      data-testid={props.testId}
      className="flex max-w-full flex-wrap items-center justify-center gap-2"
    >
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
  /** A small icon before the sentence (a warning). */
  readonly glyph?: CardGlyph
  readonly tone?: 'default' | 'muted' | 'warning' | 'danger'
  readonly testId?: string
}

const TEXT_TONE: Readonly<Record<NonNullable<RowTextProps['tone']>, string>> = {
  default: 'text-foreground',
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
      className={cn(
        'flex items-start justify-center gap-1 break-words text-center text-xs',
        TEXT_TONE[props.tone ?? 'muted'],
      )}
    >
      {props.glyph === undefined ? null : <CardIcon glyph={props.glyph} />}
      {props.text}
    </p>,
  )
}

export interface RowLinesProps extends RowBase {
  /** The bold first line. */
  readonly headline: string
  /** Smaller lines under it. */
  readonly notes: readonly string[]
  readonly testId?: string
  readonly headlineTestId?: string
}

/** A headline over a few small notes: the chosen program and its time. */
export function rowLines(key: string, props: RowLinesProps): BottomRow {
  return makeRow(
    key,
    'lines',
    props.label,
    <div
      className="grid w-full justify-items-center gap-0.5 text-center"
      data-testid={props.testId}
    >
      <b
        data-testid={props.headlineTestId}
        className="max-w-full break-words text-sm text-foreground"
      >
        {props.headline}
      </b>
      {props.notes.map((note) => (
        <small key={note} className="text-xs text-foreground-muted">
          {note}
        </small>
      ))}
    </div>,
  )
}

export interface RowListItem {
  readonly id: string
  readonly label: string
  /** Null draws a dash; an empty string draws nothing. */
  readonly value: string | null
  readonly tone?: InfoTileTone
  readonly glyph?: CardGlyph
  /** Test id of the item's tile. */
  readonly testId?: string
  /** Test id of the wrapper around the tile. */
  readonly rowTestId?: string
  /** Exposed as `data-event-key` on the wrapper. */
  readonly dataKey?: string
}

export interface RowListGroup {
  readonly id: string
  /** A small heading over the group; absent when there is one group. */
  readonly title?: string
  readonly items: readonly RowListItem[]
  readonly testId?: string
}

export interface RowListProps extends RowBase {
  readonly groups: readonly RowListGroup[]
  readonly testId?: string
}

/** Grouped one-line tiles (name left, value right): a vocabulary of declared things. */
export function rowList(key: string, props: RowListProps): BottomRow {
  return makeRow(
    key,
    'list',
    props.label,
    <div className="grid w-full gap-2" data-testid={props.testId}>
      {props.groups.map((group) => (
        <div key={group.id} className="grid gap-1" data-testid={group.testId}>
          {group.title === undefined ? null : (
            <p className="text-xs font-semibold text-foreground-muted">{group.title}</p>
          )}
          {group.items.map((item) => (
            <div key={item.id} data-testid={item.rowTestId} data-event-key={item.dataKey}>
              <InfoTile
                layout="row"
                glyph={item.glyph}
                label={item.label}
                value={item.value}
                tone={item.tone ?? 'default'}
                testId={item.testId}
              />
            </div>
          ))}
        </div>
      ))}
    </div>,
  )
}

export interface RowLevel {
  readonly id: string
  readonly label: string
  /** 0..100, null when not reported. */
  readonly percent: number | null
  readonly warn?: boolean
  readonly testId?: string
}

export interface RowLevelsProps extends RowBase {
  readonly levels: readonly RowLevel[]
}

/** Level bars, one line each: water, food, tank. */
export function rowLevels(key: string, props: RowLevelsProps): BottomRow {
  return makeRow(
    key,
    'levels',
    props.label,
    <div className="grid w-full justify-items-center gap-1.5">
      {props.levels.map((level) => (
        <LevelRow
          key={level.id}
          label={level.label}
          percent={level.percent}
          warn={level.warn}
          testId={level.testId}
        />
      ))}
    </div>,
  )
}

export interface RowTimerProps extends RowBase {
  readonly timer: SwitchTimerModel
  readonly actions: SwitchTimerActions
}

/** The switch's timed run: "- Run 25 min +", then "Stop · mm:ss". */
export function rowTimer(key: string, props: RowTimerProps): BottomRow {
  return makeRow(
    key,
    'timer',
    props.label,
    <SwitchTimer timer={props.timer} actions={props.actions} />,
  )
}

export interface RowEntryProps extends RowBase, ValueEntryProps {}

/** A typed value with its Save: a text, a date, a time. */
export function rowEntry(key: string, props: RowEntryProps): BottomRow {
  const { label, ...entry } = props
  return makeRow(key, 'entry', label, <ValueEntry {...entry} />)
}

export interface RowCodePadProps extends RowBase {
  readonly submitLabel: string
  readonly onSubmit: (code: string) => void
  readonly onCancel: () => void
  readonly testId?: string
}

/** The digit pad of a device that asks for a code before it acts. */
export function rowCodePad(key: string, props: RowCodePadProps): BottomRow {
  return makeRow(
    key,
    'codepad',
    props.label,
    <CodePad
      testId={props.testId}
      submitLabel={props.submitLabel}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
    />,
  )
}

export interface RowStepperProps extends RowBase {
  /** "Runs for". */
  readonly name: string
  /** The shown value ("10 min"); null when the device does not report it: "—". */
  readonly valueText: string | null
  readonly decreaseLabel: string
  readonly increaseLabel: string
  readonly canDecrease: boolean
  readonly canIncrease: boolean
  readonly onDecrease: () => void
  readonly onIncrease: () => void
  readonly testId?: string
}

/** A name, a value and a minus / plus pair on one line. */
export function rowStepper(key: string, props: RowStepperProps): BottomRow {
  return makeRow(
    key,
    'stepper',
    props.label,
    <span
      data-testid={props.testId}
      className="inline-flex items-center justify-center gap-1 text-xs"
    >
      <span>{props.name}</span>
      <CardButton
        glyph="minus"
        aria-label={props.decreaseLabel}
        disabled={!props.canDecrease}
        onClick={props.onDecrease}
      />
      <b className="tabular-nums">{props.valueText ?? '—'}</b>
      <CardButton
        glyph="plus"
        aria-label={props.increaseLabel}
        disabled={!props.canIncrease}
        onClick={props.onIncrease}
      />
    </span>,
  )
}
