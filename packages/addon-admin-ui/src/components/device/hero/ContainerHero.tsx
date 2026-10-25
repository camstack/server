import { type ReactElement } from 'react'
import { ContainerPrimaryHero, useSystem, type ContainerHeroChild } from '@camstack/ui-library'
import { useDevice, useDeviceChildren } from '../../../hooks/useDevice'
import type { HeroProps } from './HeroRegistry'

/**
 * Container detail hero — renders the container AS its primary child.
 *
 * A CONTAINER device has no surface of its own: it resolves a primary child
 * (priority default, or the operator's pick) and renders THAT child's HeroCard
 * via the shared ui-library control registry, bound to the child's numeric id.
 * The override that picks which child is primary is persisted DURABLY on the
 * container's `primaryChildEntityId` via `deviceManager.setPrimaryChildEntityId`,
 * keyed on the chosen child's re-sync/rename-stable `entityId`; a legacy numeric
 * `linkDeviceId` is honored as a fallback. The selector that EDITS that override
 * lives in the Device Info / Identity block (see `PrimaryChildRow`), not on this
 * hero — this hero only owns the resolved primary-child surface.
 *
 * The other children remain as detail tabs (the ChildrenList in the Overview
 * tab).
 */
export function ContainerHero({ deviceId }: HeroProps): ReactElement {
  const system = useSystem()
  const { data: device, isLoading: deviceLoading } = useDevice(deviceId)
  const { data: childrenData, isLoading: childrenLoading } = useDeviceChildren(deviceId)

  // While either query is in flight, `childrenData` is still `[]` and the
  // hero would briefly render the "No child entities" fallback, then snap to
  // the resolved primary child — a flash on every container detail nav. Hold a
  // neutral placeholder until both queries settle (see the loading guard in
  // the render below).
  const isLoading = deviceLoading || childrenLoading

  const children: readonly ContainerHeroChild[] = (childrenData ?? []).map((c) => ({
    id: c.id,
    stableId: c.stableId,
    type: c.type,
    name: c.name,
    features: c.features,
    ...(c.sourceInfo ? { sourceInfo: { id: c.sourceInfo.id } } : {}),
  }))

  const linkDeviceId = typeof device?.linkDeviceId === 'number' ? device.linkDeviceId : null
  const primaryChildEntityId =
    typeof device?.primaryChildEntityId === 'string' ? device.primaryChildEntityId : null

  // Loading guard: render a neutral skeleton instead of the "No child
  // entities" fallback while the device/children queries resolve, so a
  // container with children never flashes the empty-state on nav.
  if (isLoading) {
    return (
      <div
        className="h-full min-h-32 w-full animate-pulse rounded-lg bg-surface"
        aria-hidden="true"
      />
    )
  }

  return (
    <div className="flex h-full w-full flex-col">
      <ContainerPrimaryHero
        trpc={system.trpcClient}
        children={children}
        linkDeviceId={linkDeviceId}
        primaryChildEntityId={primaryChildEntityId}
      />
    </div>
  )
}
