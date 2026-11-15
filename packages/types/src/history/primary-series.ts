/**
 * Which history series a device card trends. Each cap declares its own
 * (`history.primary` + `history.priority`, projected into `HISTORY_PRIMARY`);
 * a device shows the primary of the ENABLED cap with the highest priority that
 * has data, falling back to the next.
 */
import { HISTORY_PRIMARY } from '../generated/history-catalog.js'

/** The history series key of a cap's declared primary field; `null` when it declares none. */
export function primarySeriesKey(cap: string): string | null {
  const primary = HISTORY_PRIMARY[cap]
  return primary === undefined ? null : `cap:${cap}.${primary.field}`
}

export interface PickPrimarySeriesInput {
  /** The caps enabled on the device (its hero layout's bindings). A disabled cap is absent. */
  readonly enabledCaps: readonly string[]
  /** Whether the device has points for a series key. */
  readonly hasData: (key: string) => boolean
}

/** The card series of a device: the data-bearing primary of the highest-priority enabled cap. */
export function pickPrimarySeriesKey(input: PickPrimarySeriesInput): string | null {
  const ranked = input.enabledCaps
    .flatMap((cap) => {
      const key = primarySeriesKey(cap)
      const primary = HISTORY_PRIMARY[cap]
      return key === null || primary === undefined ? [] : [{ key, priority: primary.priority }]
    })
    .sort((a, b) => b.priority - a.priority)
  return ranked.find((c) => input.hasData(c.key))?.key ?? null
}
