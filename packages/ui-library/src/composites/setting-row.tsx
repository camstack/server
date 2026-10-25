/**
 * SettingRow — the shared label/value row used by every settings surface.
 *
 * The row is TWO columns (label left, value right) only from
 * `SETTING_ROW_STACK_BREAKPOINT` up. Below it the row stacks: label on its own
 * line, value on the next at the full row width, wrapping rather than
 * truncating.
 *
 * That stacking is the whole point. The previous hand-rolled rows kept two
 * columns at every width, so on a phone a long label wrapped to two lines on
 * the left while its value was cut mid-word on the right — with the copy
 * button squeezed between them. The value is what an operator opens a setup
 * page to read, and it was the only part that could not be read.
 *
 * Trailing affordances (copy, reveal, a small action) go in `actions`; they
 * live inside the value lane so they stay beside the value instead of becoming
 * a third stacked line.
 */
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import {
  SETTING_ROW,
  SETTING_ROW_LABEL,
  SETTING_ROW_VALUE,
  SETTING_ROW_VALUE_TEXT,
} from '../lib/responsive'

/**
 * Which elements the row emits.
 *
 *   - `plain` (default) — `div` / `span`; valid anywhere.
 *   - `description` — `dt` / `dd` inside a wrapper `div`, so the row is a
 *     valid child of a `<dl>` (`KeyValueList`).
 */
export type SettingRowElements = 'plain' | 'description'

export interface SettingRowProps {
  /** Left-hand label. Free to wrap — it is never given a fixed width at L1. */
  readonly label: ReactNode
  /** The value. Wraps at L1, truncates from the stack breakpoint up. */
  readonly children: ReactNode
  /** Trailing affordances (copy / reveal), kept beside the value. */
  readonly actions?: ReactNode
  /** Element flavour — see `SettingRowElements`. Default `plain`. */
  readonly elements?: SettingRowElements
  /** Extra classes on the outer row. */
  readonly className?: string
  /** Extra classes on the value text (e.g. `font-mono`). */
  readonly valueClassName?: string
}

export function SettingRow({
  label,
  children,
  actions,
  elements = 'plain',
  className,
  valueClassName,
}: SettingRowProps): ReactNode {
  const LabelTag = elements === 'description' ? 'dt' : 'span'
  const ValueTag = elements === 'description' ? 'dd' : 'div'

  return (
    <div data-setting-row="" className={cn(SETTING_ROW, className)}>
      <LabelTag data-setting-row-label="" className={SETTING_ROW_LABEL}>
        {label}
      </LabelTag>
      <ValueTag data-setting-row-value="" className={SETTING_ROW_VALUE}>
        <span data-setting-row-value-text="" className={cn(SETTING_ROW_VALUE_TEXT, valueClassName)}>
          {children}
        </span>
        {actions !== undefined && (
          <span className="flex shrink-0 items-center gap-0.5">{actions}</span>
        )}
      </ValueTag>
    </div>
  )
}
