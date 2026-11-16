/**
 * The grid cameras declared before grids were core blocks (planning#580).
 *
 * They are not carried over: the operator recreates each grid as a block, and
 * every row this addon still owns under its old integration is withdrawn
 * through the declared sweep (`removeDevice` → tombstone, D865). This is the
 * index that sweep is allowed to see.
 */
import { DECLARED_DEVICE_SWEEP_LIMIT, type DeclaredDeviceRow } from '@camstack/types'

/**
 * The legacy rows, one bounded batch at a time.
 *
 * An unknown integration id yields an EMPTY index — "the lookup has not
 * answered" is not "this addon owns no rows". The batch is bounded and ordered
 * by id, so a large leftover set drains over passes instead of being refused
 * whole by the sweep's own bound.
 */
export function legacyGridCameraIndex(
  rows: readonly DeclaredDeviceRow[],
  integrationId: string | null | undefined,
): readonly DeclaredDeviceRow[] {
  if (!integrationId) return []
  return rows
    .filter((row) => row.integrationId === integrationId)
    .sort((left, right) => left.id - right.id)
    .slice(0, DECLARED_DEVICE_SWEEP_LIMIT)
}
