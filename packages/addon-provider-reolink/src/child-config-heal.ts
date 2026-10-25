import type { SavedDevice } from '@camstack/types'

/** Connection fields a hub-adopted child inherits from its parent at adoption time. */
export const INHERITED_CONNECTION_KEYS = [
  'host',
  'port',
  'username',
  'password',
  'transport',
] as const

/** Result of inspecting one child row: the patch to apply, empty when nothing is missing. */
export interface ChildConfigHeal {
  readonly patch: Record<string, unknown>
  readonly missingKeys: readonly string[]
}

/** A stored value counts as present only when it is a usable string/number. */
function isPresent(value: unknown): boolean {
  if (typeof value === 'string') return value !== ''
  return typeof value === 'number'
}

/**
 * Work out what a hub-adopted child's persisted blob is missing from the connection
 * fields it inherited from its parent when it was adopted.
 *
 * `ReolinkCamera` with a parent uses `parent.api` and never dials its own login — but
 * `reolinkCameraSchema` still requires `host` and `password` as strings, so a blob that
 * lost them fails to parse and the camera cannot be restored at all. Observed live on
 * 2026-09-04: an Argus MagiCam under a Home Hub carried `{}` and burned all four bounded
 * restore attempts on `host`/`password` — fields it would never have used.
 *
 * Only ABSENT fields are filled. A child that deliberately differs from its parent (a
 * per-child credential, a non-default port) keeps what it has.
 */
export function planChildConfigHeal(
  childConfig: Record<string, unknown>,
  parentConfig: Record<string, unknown>,
): ChildConfigHeal {
  const patch: Record<string, unknown> = {}
  const missingKeys: string[] = []
  for (const key of INHERITED_CONNECTION_KEYS) {
    if (isPresent(childConfig[key])) continue
    if (!isPresent(parentConfig[key])) continue
    patch[key] = parentConfig[key]
    missingKeys.push(key)
  }
  return { patch, missingKeys }
}

/** Find the saved row a child names as its parent. */
export function findParentRow(
  child: SavedDevice,
  allSaved: readonly SavedDevice[],
): SavedDevice | undefined {
  if (child.parentDeviceId === null) return undefined
  return allSaved.find((row) => row.id === child.parentDeviceId)
}
