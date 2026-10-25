/**
 * <PrimaryChildPicker> — controlled dropdown that selects which entity-child of
 * a CONTAINER device is its PRIMARY child.
 *
 * The picker is a thin, presentation-only controlled `<select>`: it carries each
 * child's numeric `id` on its `<option>` values (stable React keys + selection),
 * but reports a change as the chosen child's re-sync/rename-stable `entityId` —
 * which is what the durable override (`deviceManager.setPrimaryChildEntityId`)
 * persists. Resolving the CURRENT primary child (priority default vs. persisted
 * override) is the caller's job; this component only renders the choice and
 * surfaces a new pick.
 *
 * Extracted from the container detail hero so the same selector can live in the
 * device's primary config block (next to name / location) instead of floating on
 * the hero card. The hero no longer owns it.
 */
import type { ReactNode } from 'react'
import { type ContainerChild } from './container-primary'

/** A child row the picker can offer. */
export interface PrimaryChildOption extends ContainerChild {
  readonly name: string
}

export interface PrimaryChildPickerProps {
  /** The container's entity-children (from `deviceManager.getChildren`). */
  readonly childrenList: readonly PrimaryChildOption[]
  /** Numeric id of the currently-resolved primary child. */
  readonly selectedId: number
  /** Called with the picked child's re-sync/rename-stable `entityId`. */
  /** Called with the picked child's `stableId` — the canonical override key. */
  readonly onSetPrimary: (childStableId: string) => void
  /** Disable the control while a persist is in flight. */
  readonly disabled?: boolean
  /** Optional extra classes for the `<select>` (so a host row can size it). */
  readonly className?: string
}

const BASE_SELECT_CLASS =
  'rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground'

export function PrimaryChildPicker({
  childrenList,
  selectedId,
  onSetPrimary,
  disabled,
  className,
}: PrimaryChildPickerProps): ReactNode {
  return (
    <select
      value={selectedId}
      disabled={disabled}
      onChange={(e) => {
        // Options carry the child's numeric id for stable React keys/selection,
        // but the persisted override is keyed on the child's `stableId` — the
        // CANONICAL key `resolveContainerPrimaryChild` matches first, and the
        // one its docblock says new picks are written as.
        //
        // This used to write `childEntityId()`, i.e. `sourceInfo.id` when the
        // integration has one. That value cannot match on the server: the
        // `slim` projection linked-devices must use does not read `sourceInfo`,
        // and 677 of 925 container children have a `sourceInfo.id` that differs
        // from their `stableId`. So the operator picked a child, the mutation
        // answered success, and the container kept its priority default —
        // proven live on container 4127, where the pick was made twice.
        const nextId = Number(e.target.value)
        if (!Number.isFinite(nextId) || nextId === selectedId) return
        const picked = childrenList.find((c) => c.id === nextId)
        if (picked !== undefined) onSetPrimary(picked.stableId)
      }}
      className={className === undefined ? BASE_SELECT_CLASS : `${BASE_SELECT_CLASS} ${className}`}
    >
      {childrenList.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  )
}
