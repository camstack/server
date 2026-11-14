import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { CardGlyph } from '../icons'
import { ArmedButton } from '../parts/ArmedButton'
import { type CardButtonTone, CardButton, cardButtonClass } from '../parts/CardButton'
import { CardIcon } from '../parts/CardIcon'
import { type CardSliderProps, VerticalSlider } from '../parts/sliders'

let makeItem!: (key: string, node: ReactElement) => ColumnItem

/**
 * What a side column may hold: a compact control or a single short value. A
 * `ColumnItem` can only be made by the factories below, and the factories take
 * no selector, picker, segmented choice or long text — so a scene cannot put
 * one in a column, the compiler refuses it. Everything longer goes in the
 * scene's `bottom`.
 */
export class ColumnItem {
  private constructor(
    readonly key: string,
    readonly node: ReactElement,
  ) {}

  static {
    // The only way to build an item is `makeItem`, below; the constructor stays private.
    makeItem = (key, node) => new ColumnItem(key, node)
  }
}

export interface ColumnButtonProps {
  readonly glyph: CardGlyph
  /** The accessible name; a column button draws the glyph, and a short word at most. */
  readonly label: string
  readonly onPress: () => void
  readonly tone?: CardButtonTone
  /** A word of at most a few letters under the glyph ("Auto", "On"); never a sentence. */
  readonly caption?: string
  readonly pressed?: boolean
  readonly disabled?: boolean
  readonly testId?: string
}

/** Touch target 44 px on a phone; the desktop pointer gets the compact 36 px. */
const COLUMN_BUTTON_CLASS =
  'min-h-11 w-full min-w-0 max-w-14 flex-col gap-0 px-0.5 py-1 text-xs sm:min-h-9 [&_svg]:h-4 [&_svg]:w-4'

/** A button in a side column: an icon, optionally with one short word. */
export function columnButton(key: string, props: ColumnButtonProps): ColumnItem {
  return makeItem(
    key,
    <CardButton
      glyph={props.glyph}
      tone={props.tone ?? 'default'}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      data-testid={props.testId}
      className={COLUMN_BUTTON_CLASS}
      onClick={props.onPress}
    >
      {props.caption === undefined ? null : <span className="max-w-full truncate">{props.caption}</span>}
    </CardButton>,
  )
}

export interface ColumnArmedButtonProps {
  readonly glyph: CardGlyph
  readonly label: string
  readonly onConfirm: () => void
  readonly caption?: string
  readonly tone?: CardButtonTone
  readonly disabled?: boolean
  readonly testId?: string
}

/** A two-step button in a side column: the first press arms it, Confirm and Cancel stack. */
export function columnArmedButton(key: string, props: ColumnArmedButtonProps): ColumnItem {
  return makeItem(
    key,
    <ArmedButton
      stacked
      glyph={props.glyph}
      tone={props.tone}
      label={props.label}
      disabled={props.disabled}
      testId={props.testId}
      buttonClassName={COLUMN_BUTTON_CLASS}
      onConfirm={props.onConfirm}
    >
      {props.caption === undefined ? null : <span className="max-w-full truncate">{props.caption}</span>}
    </ArmedButton>,
  )
}

export interface ColumnLinkProps {
  readonly glyph: CardGlyph
  readonly label: string
  readonly href: string
  readonly testId?: string
}

/** A link that leaves the card (opens in a new tab), drawn as a column button. */
export function columnLink(key: string, props: ColumnLinkProps): ColumnItem {
  return makeItem(
    key,
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={props.testId}
      title={props.label}
      aria-label={props.label}
      className={cardButtonClass('default', false, COLUMN_BUTTON_CLASS)}
    >
      <CardIcon glyph={props.glyph} />
    </a>,
  )
}

/** A level in a side column. */
export function columnSlider(key: string, props: CardSliderProps): ColumnItem {
  return makeItem(key, <VerticalSlider {...props} />)
}

export interface ColumnValueProps {
  /** The reading, one short token ("21.5°", "35"). */
  readonly value: string
  /** What it is, one lowercase word ("target", "vol"). */
  readonly caption?: string
  readonly tone?: 'primary' | 'muted' | 'warning'
  readonly testId?: string
}

const VALUE_TONE: Readonly<Record<NonNullable<ColumnValueProps['tone']>, string>> = {
  primary: 'text-primary',
  muted: 'text-foreground-muted',
  warning: 'text-warning',
}

/** One short reading in a side column. */
export function columnValue(key: string, props: ColumnValueProps): ColumnItem {
  return makeItem(
    key,
    <span
      className="flex min-w-0 max-w-full flex-col items-center text-center leading-tight"
      data-testid={props.testId}
    >
      <b
        className={cn('max-w-full truncate text-sm tabular-nums', VALUE_TONE[props.tone ?? 'primary'])}
      >
        {props.value}
      </b>
      {props.caption === undefined ? null : (
        <small className="whitespace-nowrap text-xs lowercase text-foreground-muted">
          {props.caption}
        </small>
      )}
    </span>,
  )
}
