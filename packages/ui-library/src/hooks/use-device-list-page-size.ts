/**
 * useDeviceListPageSize — global page-size preference for the device-list
 * surfaces (Devices, Integrations, integration detail).
 *
 * ONE shared localStorage key (`camstack.device-list.pageSize`) so changing
 * the per-page size on any device-list page applies everywhere. The stored
 * value is validated against {@link DEVICE_LIST_PAGE_SIZE_OPTIONS}; any
 * garbage / out-of-range value falls back to the provided default.
 *
 * A thin binding of `usePersistedPageSize` to that key and option set; a
 * surface with a different default or options uses the generic hook with a
 * key of its own.
 */
import { usePersistedPageSize, type SetPageSize } from './use-persisted-page-size'

/** Selectable per-page sizes. The table default (50) is intentionally one of them. */
export const DEVICE_LIST_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200]

/** Canonical default — used whenever a caller's `defaultSize` is itself invalid. */
export const DEVICE_LIST_PAGE_SIZE_DEFAULT = 50

/** Single global key shared across every device-list surface. */
export const DEVICE_LIST_PAGE_SIZE_KEY = 'camstack.device-list.pageSize'

export type SetDeviceListPageSize = SetPageSize

/**
 * @param defaultSize fallback when nothing valid is stored. If it is not itself
 *   a member of {@link DEVICE_LIST_PAGE_SIZE_OPTIONS}, it is replaced by
 *   {@link DEVICE_LIST_PAGE_SIZE_DEFAULT} so it can never seed a phantom value.
 * @returns `[size, setSize]` — `setSize` ignores values outside the allowed set.
 */
export function useDeviceListPageSize(
  defaultSize: number,
): readonly [number, SetDeviceListPageSize] {
  const seed = DEVICE_LIST_PAGE_SIZE_OPTIONS.includes(defaultSize)
    ? defaultSize
    : DEVICE_LIST_PAGE_SIZE_DEFAULT
  return usePersistedPageSize({
    storageKey: DEVICE_LIST_PAGE_SIZE_KEY,
    options: DEVICE_LIST_PAGE_SIZE_OPTIONS,
    defaultSize: seed,
  })
}
