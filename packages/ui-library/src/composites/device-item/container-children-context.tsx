/**
 * Container-children context — a per-list lookup of `parentId → children`
 * so a row's sub-components (`DeviceItemHeader`, `DeviceItemActions`, the
 * table-row's `effectiveType`) can resolve a Container's children THEMSELVES
 * instead of having the array threaded down as a `containerChildren` prop.
 *
 * A Container row renders AS its primary child (icon + inline control + the
 * effective type badge), which needs the container's children. Previously the
 * owning list passed those children into `<DeviceItem>`, which re-threaded them
 * into every sub-component. The list now publishes the whole `parentId → []`
 * map once via `ContainerChildrenProvider`, and each sub-component reads its
 * own slice with `useContainerChildren(deviceId)`.
 *
 * Outside a provider (e.g. the minimal child list on the device-detail page,
 * or a standalone test) the hook returns a stable empty array — the same
 * graceful default the old optional prop had.
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { DeviceItemDevice } from './helpers'

const EMPTY: readonly DeviceItemDevice[] = []

const ContainerChildrenContext = createContext<ReadonlyMap<
  number,
  readonly DeviceItemDevice[]
> | null>(null)

export interface ContainerChildrenProviderProps {
  /** `parentDeviceId → that parent's children`. Built once by the list. */
  readonly value: ReadonlyMap<number, readonly DeviceItemDevice[]>
  readonly children: ReactNode
}

export function ContainerChildrenProvider({
  value,
  children,
}: ContainerChildrenProviderProps): ReactNode {
  return (
    <ContainerChildrenContext.Provider value={value}>{children}</ContainerChildrenContext.Provider>
  )
}

/**
 * The children of `deviceId` as published by the nearest
 * `ContainerChildrenProvider`. Returns a stable empty array when there is no
 * provider or the device has no children — so a non-container row, or a row
 * rendered outside a list, degrades exactly like the old optional prop.
 */
export function useContainerChildren(deviceId: number): readonly DeviceItemDevice[] {
  const map = useContext(ContainerChildrenContext)
  return map?.get(deviceId) ?? EMPTY
}
