/**
 * The first column both directions of the linked-devices table share: the
 * device's name, its integration · room line, and whatever notes the row adds
 * (an orphaned opt-in, a source health, a camera's unreadable slot).
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface LinkedNameCellProps {
  readonly name: string | null
  readonly deviceId: number
  readonly detail: string | null
  /** A route to the device: the name becomes a link to it. */
  readonly to?: string
  readonly children?: ReactNode
}

export function LinkedNameCell({
  name,
  deviceId,
  detail,
  to,
  children,
}: LinkedNameCellProps): ReactNode {
  return (
    <div className="flex flex-col min-w-0">
      {to === undefined ? (
        <span className="truncate text-xs text-foreground">{name ?? `#${deviceId}`}</span>
      ) : (
        <Link to={to} className="truncate text-xs text-foreground hover:underline">
          {name ?? `#${deviceId}`}
        </Link>
      )}
      {detail !== null && (
        <span className="truncate text-[11px] text-foreground-subtle">{detail}</span>
      )}
      {children}
    </div>
  )
}
