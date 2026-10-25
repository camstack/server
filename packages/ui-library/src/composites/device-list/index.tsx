/**
 * <DeviceList> — paginated, filterable, view-toggleable device list.
 *
 * Composes:
 *   - useDeviceListUrlState (URL+LS hybrid)
 *   - groupTopLevelAndAccessories (top-level vs accessory split)
 *   - <Pagination>, <FilterChips>, <DeviceListEmptyState>
 *   - <DeviceItem view={view}> per row
 *
 * Realtime: per-page useEventInvalidation calls remain authoritative for
 * Phase 2. Lifting the sync into ui-library would require a context bridge
 * that's out of scope.
 *
 * Search: debounced 300 ms before pushing to URL state. A search NARROWS the
 * rows and never opens a parent — the chevron is the only thing that does,
 * and what it opened survives the search (`DeviceModeList.openParents`).
 *
 * This module is the dispatcher + public barrel. The two render paths live
 * in focused sibling files:
 *   - device-mode.tsx  → the default registry-device list (table/cards)
 *   - generic-mode.tsx → the generic render-prop list (`mode:'generic'`)
 *   - table-layout.tsx / cards-layout.tsx → device-mode row layouts
 */
import { type ReactNode } from 'react'
import { DeviceModeList, type DeviceListDeviceProps } from './device-mode'
import { GenericModeList, type DeviceListGenericProps } from './generic-mode'

export { countableDevices } from './group'
export { resolveDeviceIntegration, deviceIntegrationResolver } from './device-integration'
export type {
  DeviceIntegrationLink,
  DeviceIntegrationRef,
  DeviceIntegrationResolution,
  DeviceIntegrationResolver,
} from './device-integration'
export { fuzzyMatch, normalizeForSearch } from './fuzzy-match'
export {
  DEVICE_COLUMNS,
  columnsForContext,
  COLUMN_PRIORITY,
  COLUMN_BREAKPOINT_CLASS,
} from './columns'
export type { DeviceColumnId, TableContext } from './columns'
export { nextSort, sortRows } from './sort'
export type { DeviceSort, SortDirection, SortableColumnId } from './sort'
export { hardwareLabel, metadataEntries, metadataString } from './hardware'
export { IconAction, type IconActionProps } from './icon-action'
export type {
  DeviceListAddonOption,
  DeviceListDeviceProps,
  DeviceListBatchActions,
  DeviceListIntegrationIconResolver,
  DeviceListIntegrationOption,
} from './device-mode'
export type {
  DeviceListColumn,
  DeviceListGenericProps,
  GenericPageSizeSelector,
} from './generic-mode'
export { PageSizeSelect, pageSizeLabel, type PageSizeSelectProps } from './page-size-select'
export { Pagination, computePageButtons, type PaginationProps, type PageButton } from './pagination'

/**
 * Default registry-device list, or a generic render-prop list (`mode:'generic'`).
 * Existing call sites pass no `mode` and resolve to the device variant unchanged.
 */
export type DeviceListProps<T = unknown> = DeviceListDeviceProps | DeviceListGenericProps<T>

/**
 * Dispatcher: default registry-device list, or a generic render-prop list when
 * `mode:'generic'`. The two paths are separate component instances so their
 * hooks never interleave (a given call site's mode is stable).
 */
export function DeviceList<T = unknown>(props: DeviceListProps<T>): ReactNode {
  if ('mode' in props && props.mode === 'generic') {
    return <GenericModeList {...props} />
  }
  return <DeviceModeList {...props} />
}
