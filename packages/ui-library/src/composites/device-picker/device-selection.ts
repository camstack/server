/**
 * What a device picker says about the ids it has SELECTED — including the ones
 * the hub no longer has.
 *
 * The picker draws the live camera list; a selected id outside that list would
 * otherwise be invisible and impossible to deselect (operator report
 * 2026-09-25: a deleted camera kept a rule matching nothing while the editor
 * showed "all devices"). Two rules shape this module:
 *
 *  - D315: absence is claimed only from a list that ANSWERED. Pending and
 *    failed lists never mark an id `removed`.
 *  - D49: a read never destroys. Every selected id comes back as a row; the
 *    selection is changed only by the operator.
 *
 * Generic over {@link SelectionId} since D637: the system family's node and
 * package pickers select string ids under the same two rules. It declares its
 * own id type rather than importing the picker model's, so the byte-identical
 * copies share no import specifier that would differ between them.
 *
 * TWO BYTE-IDENTICAL COPIES: `camstack/src/components/notifications/
 * device-selection.ts` (viewer) and `packages/addon-admin-ui/src/pages/system/
 * device-selection.ts` (admin). The viewer resolves `@camstack/types` from a
 * published release, so a helper added to the workspace would not exist
 * there. `scripts/check-device-selection-in-sync.ts` (camstack-server) fails
 * the commit when the copies differ; edit both.
 */

/** A selected id: a device id, or a node id / package name (D637). */
export type SelectionId = number | string

/** Where the camera list is: answered (data present), pending, or failed. */
export type DeviceListState = 'answered' | 'pending' | 'failed'

/** The minimum a camera needs to name a selected row. */
export interface NamedDevice<Id extends SelectionId = number> {
  readonly id: Id
  readonly name: string
}

/** One selected id. `name` only when the answered list has it. */
export interface SelectedDeviceRow<Id extends SelectionId = number> {
  readonly id: Id
  readonly name?: string
  readonly removed: boolean
}

/** The slice of a query result the state is derived from. */
export interface DeviceListQueryLike<Id extends SelectionId = number> {
  readonly data: readonly NamedDevice<Id>[] | undefined
  readonly isError: boolean
}

export function deviceListStateOf<Id extends SelectionId = number>(
  query: DeviceListQueryLike<Id>,
): DeviceListState {
  if (query.data !== undefined) return 'answered'
  return query.isError ? 'failed' : 'pending'
}

export function resolveSelectedDevices<Id extends SelectionId = number>(
  selectedIds: readonly Id[],
  cameras: readonly NamedDevice<Id>[] | undefined,
  state: DeviceListState,
): SelectedDeviceRow<Id>[] {
  if (state !== 'answered' || cameras === undefined) {
    return selectedIds.map((id) => ({ id, removed: false }))
  }
  const byId = new Map(cameras.map((cam) => [cam.id, cam.name]))
  return selectedIds.map((id) => {
    const name = byId.get(id)
    return name === undefined ? { id, removed: true } : { id, name, removed: false }
  })
}

/**
 * The selected ids a picker's DRAWN list does not contain, judged against the
 * WHOLE fleet — never against the drawn list itself. A camera picker draws
 * cameras, but a rule's devices can be a sensor picked on another surface: the
 * camera list lacking it says nothing about whether it still exists. Each row
 * is `removed` (the answered fleet lacks it), named (the fleet has it) or
 * unnamed (the fleet has not answered).
 */
export function offListSelections<Id extends SelectionId = number>(
  selectedIds: readonly Id[],
  listed: readonly NamedDevice<Id>[] | undefined,
  fleet: readonly NamedDevice<Id>[] | undefined,
  fleetState: DeviceListState,
): SelectedDeviceRow<Id>[] {
  const listedIds = new Set<Id>((listed ?? []).map((device) => device.id))
  return resolveSelectedDevices(
    selectedIds.filter((id) => !listedIds.has(id)),
    fleet,
    fleetState,
  )
}

/** The "no cameras" hint: only an ANSWERED empty list with nothing selected. */
export function showsNoCamerasHint(
  state: DeviceListState,
  cameraCount: number,
  selectedCount: number,
): boolean {
  return state === 'answered' && cameraCount === 0 && selectedCount === 0
}

/**
 * The widening warning: on a picker where an empty selection means ALL
 * devices, an empty selection that once held devices must say so.
 */
export function emptyDevicesWidens(
  emptyMeansAll: boolean,
  selectedCount: number,
  hadDevices: boolean,
): boolean {
  return emptyMeansAll && selectedCount === 0 && hadDevices
}
