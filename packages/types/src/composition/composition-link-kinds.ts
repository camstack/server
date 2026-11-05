/**
 * Every link a device keeps in its STORED composition that a surface must
 * show to the operator. One list: the guard `check-customize-coverage` fails
 * for a kind without a renderer in admin-ui or ui-library, so a link that is
 * stored but never drawn (a lock's door sensor shown on the container instead
 * of the lock) cannot ship quietly. A slot-backed link (`linked-devices`) is
 * covered by `EXTENSION_SLOT_IDS`, not here.
 */
export const COMPOSITION_LINK_KINDS = ['lock-door-sensor', 'power-source'] as const
export type CompositionLinkKind = (typeof COMPOSITION_LINK_KINDS)[number]
