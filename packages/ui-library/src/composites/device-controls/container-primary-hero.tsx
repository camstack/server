/**
 * <ContainerPrimaryHero> — renders a CONTAINER device's detail hero AS its
 * primary child.
 *
 * The container has no surface of its own: it resolves a primary child
 * (priority default, or the operator's durable primary-child pick) and renders
 * THAT child's `HeroCard` from the shared control registry, bound to the child's
 * numeric id — identical to opening the child device directly.
 *
 * The override is persisted as the chosen child's re-sync/rename-stable
 * `entityId` (`primaryChildEntityId`); resolution matches on it directly — see
 * `container-primary.ts`. A legacy numeric `linkDeviceId` is still honored as a
 * fallback. Other children remain as detail tabs (owned by the device-detail
 * page); this component only owns the hero surface. The "primary child" picker
 * that overrides the resolution lives in the device's primary config block (see
 * admin-ui `PrimaryChildRow`), wired to `deviceManager.setPrimaryChildEntityId`.
 */
import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { resolveDeviceControl } from './control-registry'
import { DummyHeroCard } from './dummy-hero-card'
import { resolveContainerPrimary, type ContainerChild } from './container-primary'

/** A child row the hero can render. */
export interface ContainerHeroChild extends ContainerChild {
  readonly name: string
  readonly features?: readonly string[]
}

export interface ContainerPrimaryHeroProps {
  readonly trpc: UseDeviceProxyTrpc
  /** The container's entity-children (from `deviceManager.getChildren`). */
  readonly children: readonly ContainerHeroChild[]
  /** Container's LEGACY persisted primary-child override (numeric child id) —
   *  consulted only when no durable `primaryChildEntityId` is set. */
  readonly linkDeviceId: number | null | undefined
  /** Container's DURABLE primary-child override (chosen child's entityId) —
   *  null/undefined ⇒ no durable override (falls back to linkDeviceId, then
   *  priority default). */
  readonly primaryChildEntityId?: string | null | undefined
}

export function ContainerPrimaryHero({
  trpc,
  children,
  linkDeviceId,
  primaryChildEntityId,
}: ContainerPrimaryHeroProps): ReactNode {
  const t = useUiText()
  const primary = resolveContainerPrimary(children, linkDeviceId, primaryChildEntityId)
  const primaryChild = primary === null ? undefined : children.find((c) => c.id === primary.id)

  if (primaryChild === undefined) {
    // Container with no children — nothing to render as. Degrade gracefully.
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-[11px] italic text-foreground-subtle">
        {t('uiLibrary.containerPrimaryHero.empty', 'No child entities to display.')}
      </div>
    )
  }

  const control = resolveDeviceControl(primaryChild.type)
  const HeroCard = control?.HeroCard ?? DummyHeroCard

  return (
    <div className="flex h-full w-full flex-col items-stretch gap-3 p-3 sm:p-4">
      <HeroCard trpc={trpc} deviceId={primaryChild.id} features={primaryChild.features} />
    </div>
  )
}
