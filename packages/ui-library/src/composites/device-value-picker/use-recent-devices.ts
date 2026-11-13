import { useCallback, useState } from 'react'
import { pushRecent } from './device-value-picker-model'

const STORAGE_PREFIX = 'camstack.deviceValuePicker.recent.'

function read(key: string): readonly number[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + key) ?? '[]')
    return Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

/**
 * The devices one field offered last time, most recent first — a per-viewer
 * convenience only: storage can be absent or throw, and the picker is whole
 * without it.
 *
 * `ids` is a SNAPSHOT: it is read on mount and again by `refresh()` (the
 * picker calls it when it opens) and never moves in between. `push` only
 * writes the store, so a pick made while the list is open cannot reorder it
 * or throw the scroll position away.
 */
export interface RecentDevices {
  readonly ids: readonly number[]
  readonly push: (deviceId: number) => void
  readonly refresh: () => void
}

export function useRecentDevices(key: string | undefined): RecentDevices {
  const [ids, setIds] = useState<readonly number[]>(() => (key === undefined ? [] : read(key)))
  const push = useCallback(
    (deviceId: number) => {
      if (key === undefined) return
      const next = pushRecent(read(key), deviceId)
      try {
        window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(next))
      } catch {
        // Storage is a convenience; ignore a refusal.
      }
    },
    [key],
  )
  const refresh = useCallback(() => {
    setIds(key === undefined ? [] : read(key))
  }, [key])
  return { ids, push, refresh }
}
