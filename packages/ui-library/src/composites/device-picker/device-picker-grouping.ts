/**
 * The admin side of the device picker's "Group by" (Zone | Location | None):
 * the remembered choice, and the site-zone read. What each mode DRAWS is
 * `device-picker-model.ts` (shared with the viewer); this only supplies what
 * is side-specific.
 *
 *  - The choice lives in `localStorage`, one value for every device picker in
 *    this browser. Storage that throws or holds an unknown value is the
 *    default (`zone`), never an error.
 *  - The zones are read whenever the picker's panel is open (the Zone filter
 *    needs them even in Location or None mode) — the caller mounts this with
 *    the panel — and a failure stays a FAILURE: an
 *    empty list would put every device under "No zone", a claim of absence
 *    from a read that did not answer (D315). The model then groups by
 *    location and the panel says why.
 */
import { useSystem } from '../../contexts/system-context.js'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  PICKER_DEFAULT_GROUP_BY,
  type PickerGroupBy,
  type PickerZonesRead,
  parsePickerGroupBy,
} from './device-picker-model'

export const DEVICE_PICKER_GROUP_STORAGE_KEY = 'camstack.admin.device-picker.group-by'

/**
 * Under `listSiteZones`'s own prefix, so the Locations page's invalidation of
 * `[['deviceManager', 'listSiteZones']]` refreshes it too.
 */
const PICKER_ZONES_QUERY_KEY = [['deviceManager', 'listSiteZones'], 'device-picker'] as const
const PICKER_ZONES_STALE_MS = 60_000

/** The stored choice; the default when storage is absent, throws or is unreadable. */
export function readStoredGroupBy(): PickerGroupBy {
  try {
    const raw = globalThis.localStorage?.getItem(DEVICE_PICKER_GROUP_STORAGE_KEY) ?? null
    return raw === null ? PICKER_DEFAULT_GROUP_BY : parsePickerGroupBy(raw)
  } catch {
    return PICKER_DEFAULT_GROUP_BY
  }
}

/** Remember the choice; a storage that refuses keeps it for this page only. */
export function writeStoredGroupBy(next: PickerGroupBy): void {
  try {
    globalThis.localStorage?.setItem(DEVICE_PICKER_GROUP_STORAGE_KEY, next)
  } catch {
    // Storage unavailable (private window, quota): the choice holds until reload.
  }
}

/** The group-by choice, seeded from and written to `localStorage`. */
export interface StoredGroupBy {
  readonly groupBy: PickerGroupBy
  readonly setGroupBy: (next: PickerGroupBy) => void
}

export function useStoredGroupBy(): StoredGroupBy {
  const [groupBy, setState] = useState<PickerGroupBy>(readStoredGroupBy)
  const setGroupBy = (next: PickerGroupBy): void => {
    setState(next)
    writeStoredGroupBy(next)
  }
  return { groupBy, setGroupBy }
}

/** The site zones, with whether the read ANSWERED — read only while `enabled`. */
export function usePickerSiteZones(enabled: boolean): PickerZonesRead {
  const trpcClient = useSystem().trpcClient
  const query = useQuery({
    queryKey: PICKER_ZONES_QUERY_KEY,
    enabled,
    staleTime: PICKER_ZONES_STALE_MS,
    queryFn: () => trpcClient.deviceManager.listSiteZones.query(),
  })
  // One object per ANSWER, not per render: the panel regroups whenever this
  // changes, and a fresh object each keystroke would regroup on every one.
  const { data, isError } = query
  return useMemo((): PickerZonesRead => {
    if (data !== undefined) return { state: 'answered', zones: data }
    return isError ? { state: 'failed' } : { state: 'pending' }
  }, [data, isError])
}
