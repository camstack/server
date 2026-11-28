/**
 * The fields of a `time-is` row: the library's `TimeWindowInput` over the
 * leaf's window (the whole day, two times, or a Day / Night preset, and the
 * days). The days name the day a window STARTS on, which the input says when
 * the window ends the next day. The leaf keeps its `kind`; the window keys
 * are stored exactly as the input emits them.
 */
import type { TimeIsLeaf } from '@dominevo/types'
import { TimeWindowInput, useSystemGetSiteLocation } from '@dominevo/ui-library'

export interface TimeIsFieldsProps {
  readonly leaf: TimeIsLeaf
  readonly onChange: (next: TimeIsLeaf) => void
}

export function TimeIsFields({ leaf, onChange }: TimeIsFieldsProps) {
  const { kind: _kind, ...window } = leaf
  // Only a site that ANSWERED with no location disables the sun ends and the presets; while the
  // read is pending nothing is disabled (not-yet-known is not "no location").
  const reading = useSystemGetSiteLocation().data
  const siteHasNoLocation = reading !== undefined && reading.location === null
  return (
    <TimeWindowInput
      value={window}
      siteHasNoLocation={siteHasNoLocation}
      testIdPrefix="time-is"
      onChange={(next) => onChange({ kind: 'time-is', ...next })}
    />
  )
}
