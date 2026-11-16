/**
 * Library → Exports narrowed to one camera: `?camera=<deviceId>`, the param the
 * Archive links with. A missing or malformed param is "every camera".
 */
/** Anything kept per camera — an export row is one. */
export interface CameraOwned {
  readonly deviceId: number
}

/** The camera a `?camera=` value names, or null for every camera. */
export function parseExportCamera(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  return Number(value)
}

/** The exports of one camera; every export when no camera is picked. */
export function exportsOfCamera<T extends CameraOwned>(
  rows: readonly T[],
  deviceId: number | null,
): readonly T[] {
  return deviceId === null ? rows : rows.filter((row) => row.deviceId === deviceId)
}

/** The cameras the exports belong to, plus the picked one, sorted by id. */
export function exportCameraIds(
  rows: readonly CameraOwned[],
  picked: number | null,
): readonly number[] {
  const ids = new Set(rows.map((row) => row.deviceId))
  if (picked !== null) ids.add(picked)
  return [...ids].sort((a, b) => a - b)
}
