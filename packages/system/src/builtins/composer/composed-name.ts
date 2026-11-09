/**
 * Which name wins when a user-named composed device and its block disagree.
 *
 * Both operator renames write both sides: the device page writes the block,
 * the composition editor writes the device. A mismatch is a write that did
 * not land. The device row has no name-change time, so the two failures look
 * the same once nothing is remembered:
 *
 * - a device-page rename whose block write failed (the device name is newer);
 * - an editor rename whose device write failed (the block name is newer).
 *
 * A restart remembers nothing. The handle was just built from the row, so its
 * name is the stored one, and that name wins — copying the block onto a row
 * the operator named was the bug. While this process remembers the previous
 * apply, a block whose name changed keeps it, and the stamped device write is
 * retried (`nameOwed`) until it lands. `setName` does not update the live
 * handle, so the handle still showing the old name after that write is stale,
 * not a newer device-page rename. A device-page rename whose block write
 * failed is repaired on the restart that rebuilds the handle from the row.
 */
export type ComposedNameAuthority = 'device' | 'block'

export interface RememberedCompositionName {
  /** The name the previous apply decided. Null when that row's name was unreadable. */
  readonly appliedName: string | null
  /** The block name at the previous apply. Null when that row's name was unreadable. */
  readonly blockName: string | null
  /** A block name whose device write has not landed yet. */
  readonly nameOwed: string | null
}

export function composedNameAuthority(
  deviceName: string,
  blockName: string,
  remembered: RememberedCompositionName | null,
): ComposedNameAuthority {
  if (remembered === null) return 'device'
  if (remembered.nameOwed === blockName) return 'block'
  if (blockName !== remembered.blockName) return 'block'
  if (deviceName !== blockName && remembered.appliedName === deviceName) return 'device'
  return 'block'
}
