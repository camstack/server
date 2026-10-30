/**
 * The broker picker a host mounts for `broker-select` fields.
 *
 * Creating a broker needs the host's sign-in dialogs, which the library does
 * not carry, so the host supplies the picker (`BrokerPicker` in admin-ui) here.
 * Without one, `broker-select` still lists the existing brokers and lets the
 * operator choose; it just cannot create.
 */
import { useContext, type ComponentType, type JSX, type ReactNode } from 'react'
import { createSharedContext } from '../lib/shared-context'

export interface BrokerPickerSlotProps {
  /** Broker kind to list and to create. */
  readonly kind: string
  readonly value: string | null
  readonly onChange: (brokerId: string | null) => void
}

export type BrokerPickerSlot = ComponentType<BrokerPickerSlotProps>

const BrokerPickerSlotContext = createSharedContext<BrokerPickerSlot | null>(
  'camstack:broker-picker-slot',
  null,
)

export function BrokerPickerSlotProvider({
  picker,
  children,
}: {
  readonly picker: BrokerPickerSlot
  readonly children: ReactNode
}): JSX.Element {
  return (
    <BrokerPickerSlotContext.Provider value={picker}>{children}</BrokerPickerSlotContext.Provider>
  )
}

export function useBrokerPickerSlot(): BrokerPickerSlot | null {
  return useContext(BrokerPickerSlotContext)
}
