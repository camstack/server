/**
 * An EXTENSION SLOT — one way a device can be extended by OTHER devices,
 * declared by the capability that already owns the function (D648).
 *
 * A slot is metadata, and behavioural metadata lives in the owning `*.cap.ts`
 * (D4): `device-manager.cap.ts` declares `linked-devices`, today the only
 * slot. `npm run codegen` folds every declaration into
 * `generated/extension-slots.ts` (the id enum, the table and the discriminated
 * union of slot values), and `device-extension` is the device-scoped
 * collection contract that lists and writes them. The contract persists
 * NOTHING: each slot is served by the addon that owns its store (D62).
 *
 * One shape, `association` — the host LISTS other devices (a camera's linked
 * devices). Removing every source is "off";
 * there is no separate switch.
 *
 * A host that GAINS a whole capability from other devices is not a slot: that
 * is a COMPOSITION (D663, amends D648). D648 reserved a `graft` shape for it
 * (with a `projects` cap and an `enabled` switch); none was ever implemented,
 * and it was retired in favour of composed devices and device customization.
 */
import type { z } from 'zod'
import type { DeviceType } from '../device/device-type.js'

/** How a slot extends its host. See the module docblock. */
export type ExtensionSlotShape = 'association'

/** How many sources a slot takes. */
export type ExtensionSlotCardinality = 'one' | 'many'

/**
 * One slot, as declared in its owning `*.cap.ts`.
 *
 * `value` is the slot's EDITABLE value — what `setSlot` takes and `listSlots`
 * returns. It must be a Zod OBJECT that does not itself carry a `slot` key:
 * codegen extends it with `slot: z.literal(<id>)` to build the discriminated
 * union, and it must be a NAMED EXPORT of the declaring cap file (codegen
 * imports it by name so the generated module never imports the caps barrel).
 */
export interface ExtensionSlotDescriptor<TValue extends z.ZodObject = z.ZodObject> {
  /** Kebab id, unique across every cap. Becomes a member of `ExtensionSlotId`. */
  readonly id: string
  /** Operator-facing name of the slot ("Linked devices"). */
  readonly label: string
  /** One sentence saying what a source of this slot DOES to the host. */
  readonly description: string
  readonly shape: ExtensionSlotShape
  /**
   * Host device types the slot is offered on. Absent = the declaring cap's
   * `deviceTypes`; a slot on a cap that declares none (a `system` cap such as
   * `device-manager`) MUST state it (guarded).
   */
  readonly hostDeviceTypes?: readonly DeviceType[]
  /**
   * Source filter for the picker, tested against a candidate's capabilities
   * (D12: its bindings, never the global cap list). `'any'` = no cap filter.
   */
  readonly sourceCaps: readonly string[] | 'any'
  readonly cardinality: ExtensionSlotCardinality
  /** The slot's editable value. See the interface docblock. */
  readonly value: TValue
}
