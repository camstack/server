/**
 * usePersistedPageSize — a "rows per page" choice remembered per viewer.
 *
 * The caller names the storage key, the allowed sizes and the default. Each
 * surface with its own default or option set keeps its own key, so one
 * surface's choice never lands on another that cannot show it (the device
 * list's global key stays `useDeviceListPageSize`'s, with its own options).
 *
 * `PAGE_SIZE_ALL` (0) is the "All" option: one page holding every row.
 *
 * Storage is a convenience, never a requirement: every read and write is
 * guarded, and a blocked / private-mode / missing storage simply means the
 * choice lasts until the page is left. A stored value that is not one of the
 * options (an older option set, a hand-edited value) is ignored.
 */
import { useCallback, useState } from 'react'

/** The "All" option — one page holding every row. */
export const PAGE_SIZE_ALL = 0

export interface PersistedPageSizeConfig {
  /** localStorage key, or null for a choice that is not remembered. */
  readonly storageKey: string | null
  /** The selectable sizes, in display order. May include `PAGE_SIZE_ALL`. */
  readonly options: readonly number[]
  /** The size before the viewer picks one. Replaced by `options[0]` if not an option. */
  readonly defaultSize: number
}

export type SetPageSize = (next: number) => void

function readStored(key: string | null, options: readonly number[], fallback: number): number {
  if (key === null || typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && options.includes(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string | null, value: number): void {
  if (key === null || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    /* storage blocked or full — the choice lasts for this page only */
  }
}

/** @returns `[size, setSize]`; `setSize` ignores a size that is not an option. */
export function usePersistedPageSize({
  storageKey,
  options,
  defaultSize,
}: PersistedPageSizeConfig): readonly [number, SetPageSize] {
  const seed = options.includes(defaultSize) ? defaultSize : (options[0] ?? defaultSize)
  const [size, setSize] = useState<number>(() => readStored(storageKey, options, seed))

  const update = useCallback<SetPageSize>(
    (next) => {
      if (!options.includes(next)) return
      setSize(next)
      writeStored(storageKey, next)
    },
    [options, storageKey],
  )

  return [size, update] as const
}

/**
 * The number of rows one page holds for a chosen size: "All" is every row
 * (at least 1, so the pager arithmetic never divides by zero).
 */
export function effectivePageSize(size: number, totalItems: number): number {
  return size === PAGE_SIZE_ALL ? Math.max(1, totalItems) : size
}
