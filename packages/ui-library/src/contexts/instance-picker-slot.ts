/**
 * The instance picker a host mounts for `instance-select` fields (D1013 rule 5).
 *
 * Creating an instance needs the host's sign-in dialogs, which the library does not carry, so the
 * host supplies the picker here. Without one, `instance-select` still lists the existing instances
 * and lets the operator choose; it just cannot create.
 */
import { createElement, useContext, type ComponentType, type JSX, type ReactNode } from 'react'
import { createSharedContext } from '../lib/shared-context'

export interface InstancePickerSlotProps {
  /** The function cap whose instances are listed. */
  readonly functionCap: string
  /** One kind of that cap; absent lists every kind. */
  readonly kind?: string
  readonly value: string | null
  readonly onChange: (instanceId: string | null) => void
}

export type InstancePickerSlot = ComponentType<InstancePickerSlotProps>

const InstancePickerSlotContext = createSharedContext<InstancePickerSlot | null>(
  'camstack:instance-picker-slot',
  null,
)

export function InstancePickerSlotProvider({
  picker,
  children,
}: {
  readonly picker: InstancePickerSlot
  readonly children: ReactNode
}): JSX.Element {
  return createElement(InstancePickerSlotContext.Provider, { value: picker }, children)
}

export function useInstancePickerSlot(): InstancePickerSlot | null {
  return useContext(InstancePickerSlotContext)
}
