/**
 * `<HardwareCell>` — the inner content of the device-table `manufacturer`
 * column's `<td>`. Renders the compact `manufacturer · model` label and, on
 * hover/focus, a tooltip listing the FULL device-metadata identity blob
 * (every string-coercible, non-empty key/value pair).
 *
 * Reuses the shared `<Tooltip>` primitive (`primitives/tooltip`). The default
 * tooltip is single-line (`whitespace-nowrap`); we override that so the
 * key/value list wraps and left-aligns. When there's no usable metadata the
 * cell shows an em-dash and no tooltip wraps it (nothing to reveal).
 */
import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '../../primitives/tooltip'
import type { DeviceItemDevice } from '../device-item/helpers'
import { hardwareLabel, metadataEntries } from './hardware'

interface HardwareCellProps {
  readonly device: DeviceItemDevice
}

export function HardwareCell({ device }: HardwareCellProps): ReactNode {
  const label = hardwareLabel(device)
  const entries = metadataEntries(device.metadata)

  // Nothing to show → em-dash, no tooltip (a tooltip with no content is noise).
  if (label === null && entries.length === 0) {
    return <span className="text-xs text-foreground-subtle/60">—</span>
  }

  const text = label ?? '—'

  // A label but no tooltip-worthy entries (shouldn't happen — a label implies a
  // manufacturer/model entry — but stay defensive): render the bare label.
  if (entries.length === 0) {
    return <span className="block truncate text-xs text-foreground-subtle">{text}</span>
  }

  return (
    // `block w-full min-w-0` makes the tooltip wrapper fill the width-constrained
    // <td> (overriding the primitive's default `inline-block`, which would
    // shrink-to-fit and let a long `manufacturer · model` string overflow into
    // the Features column). With a bounded block ancestor the inner `truncate`
    // span ellipsizes instead of overlapping the next column.
    <Tooltip className="block w-full min-w-0">
      <TooltipTrigger className="block w-full min-w-0">
        <span className="block truncate text-xs text-foreground-subtle">{text}</span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-normal text-left max-w-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {entries.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="font-medium opacity-70">{entry.key}</dt>
              <dd className="break-words">{entry.value}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  )
}
