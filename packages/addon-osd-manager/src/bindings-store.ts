/**
 * Per-camera slot bindings, persisted in the addon's own per-device store.
 *
 * One key per device holding the WHOLE `slotId → binding` map, round-tripped
 * through Zod on every read and write (`BaseAddon.deviceState`), so no field
 * can be dropped on save by a hand-listed persist.
 */
import { type OsdSlotBinding, OsdSlotBindingSchema } from '@camstack/types'
import { z } from 'zod'

/** Store key inside the addon's per-device store. */
export const OSD_BINDINGS_KEY = 'slotBindings'

export const OsdDeviceBindingsSchema = z.record(z.string(), OsdSlotBindingSchema)
export type OsdDeviceBindings = z.infer<typeof OsdDeviceBindingsSchema>

export const EMPTY_BINDINGS: OsdDeviceBindings = {}

/** A durable handle over one device's binding map. */
export interface BindingsHandle {
  get(): Promise<OsdDeviceBindings>
  set(next: OsdDeviceBindings): Promise<void>
  update(fn: (prev: OsdDeviceBindings) => OsdDeviceBindings): Promise<void>
}

/** Immutably set one slot's binding. */
export function withBinding(
  prev: OsdDeviceBindings,
  slotId: string,
  binding: OsdSlotBinding,
): OsdDeviceBindings {
  return { ...prev, [slotId]: binding }
}

/** Immutably drop one slot's binding. */
export function withoutBinding(prev: OsdDeviceBindings, slotId: string): OsdDeviceBindings {
  const next: OsdDeviceBindings = { ...prev }
  delete next[slotId]
  return next
}
