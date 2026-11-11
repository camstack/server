import type { ReactElement } from 'react'

export interface KeyValueProps {
  readonly label: string
  readonly value: string
}

/** One "label … value" line of a popover. */
export function KeyValue({ label, value }: KeyValueProps): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-foreground-muted">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}
