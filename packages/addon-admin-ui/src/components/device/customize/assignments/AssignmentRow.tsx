/**
 * One assigned device (spec §6, U14). Desktop: name | meta | value | ✕ on one
 * grid line; below `sm` the row stacks — the name line carries ✕, the meta
 * (a mode select) and the value sit under it. A row owns no store.
 *
 * Density is the device page's list row (`LIST_ROW`, `text-xs`, a `sm`
 * IconButton) — the same rhythm as the Bindings table and the Overview cards.
 */
import { IconButton, LIST_ROW } from '@camstack/ui-library'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LiveValueDisplay, LiveValueTarget } from './live-value'
import { LiveValueText, ValueText } from './LiveValueText'

export interface AssignmentRowProps {
  readonly name: string
  readonly detail: string | null
  /** Third column: a cap name, "Native", or the per-row options (a mode select). */
  readonly meta: ReactNode
  readonly value: LiveValueTarget | null
  /**
   * A value the caller already decided, shown INSTEAD of reading `value` live
   * (`null` = show none). The camera's own motion row uses it: its value is the
   * camera's raw level from the camera-sensors status, not the slice (D696).
   */
  readonly shown?: LiveValueDisplay | null
  /**
   * The value column drawn by the caller (a consumable's level badge), INSTEAD
   * of `shown` or the live text. Takes precedence over both.
   */
  readonly readout?: ReactNode
  /** A warning about this row (missing device, unsupported, offline). */
  readonly problem?: string
  /** Absent = not removable (the camera's own motion, a native battery, an implied device). */
  readonly onRemove?: () => void
  readonly removeLabel: string
  readonly busy?: boolean
}

export function AssignmentRow({
  name,
  detail,
  meta,
  value,
  shown,
  readout,
  problem,
  onRemove,
  removeLabel,
  busy = false,
}: AssignmentRowProps): ReactNode {
  return (
    <li
      className={`${LIST_ROW} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_1.75rem]`}
    >
      <div className="min-w-0">
        <div className="text-xs text-foreground break-words">{name}</div>
        {detail !== null && (
          <div className="text-[11px] text-foreground-subtle break-words">{detail}</div>
        )}
        {problem !== undefined && (
          <div role="alert" className="text-[11px] text-warning break-words">
            {problem}
          </div>
        )}
      </div>
      <div className="row-start-2 col-start-1 text-[11px] text-foreground-subtle empty:hidden sm:row-start-auto sm:col-start-auto sm:empty:block">
        {meta}
      </div>
      <div className="row-start-3 col-start-1 empty:hidden sm:row-start-auto sm:col-start-auto sm:empty:block">
        {readout !== undefined ? (
          readout
        ) : shown === undefined ? (
          <LiveValueText target={value} />
        ) : (
          shown !== null && <ValueText display={shown} />
        )}
      </div>
      <div className="row-start-1 col-start-2 flex justify-end sm:row-start-auto sm:col-start-auto">
        {onRemove !== undefined && (
          <IconButton
            icon={X}
            variant="ghost"
            size="sm"
            aria-label={removeLabel}
            disabled={busy}
            onClick={onRemove}
          />
        )}
      </div>
    </li>
  )
}
