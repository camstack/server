/**
 * Read-back decode for the navigation status — what the robot SAYS, as
 * opposed to what we last asked of it.
 *
 * Two properties carry the fill light on the X50 / r2538z:
 *   - `4/50`     — packed JSON `{"k":"FillinLight","v":0|1}` (the same shape
 *                  `flashWrite` sends). `v` is the light being ON.
 *   - `10001/9`  — `fillinLightSet`, a STRING: `"101"` = auto, `"40".."100"` =
 *                  the manual level. Absent while no camera session ran.
 *
 * The follow flag needs no property of its own: person-follow is a robot
 * STATE (`MiotState.Following = 26`, the same value `personFollow` selects
 * on `callAction(4,1,[{piid:1,value:26}])`), so the shared vacuum status
 * reports it — `decodeFollowing` reads it there.
 *
 * Everything here is pure and tolerant: a property that is missing, malformed
 * or of another key decodes to NOTHING (an empty patch), never to a default —
 * the previous slice keeps its value.
 */
import type { NavigationStatus } from '@camstack/types'
import { NAVIGATION_LIGHT_LEVEL_MAX, NAVIGATION_LIGHT_LEVEL_MIN } from '@camstack/types'

/** The fill-light on/off packed property. */
export const FILL_LIGHT_SIID = 4
export const FILL_LIGHT_PIID = 50
/** The camera-service fill-light mode/level property. */
export const FILL_LIGHT_SET_SIID = 10001
export const FILL_LIGHT_SET_PIID = 9
/** The wire value that means "auto" on `fillinLightSet`. */
const FILL_LIGHT_AUTO = 101

export type NavigationStatusPatch = Partial<
  Pick<NavigationStatus, 'flash' | 'lightMode' | 'lightLevel'>
>

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** `4/50` → `{ flash }`, only when the packed key is the fill light. */
export function decodeFillLight(raw: unknown): NavigationStatusPatch {
  const record = asRecord(raw)
  if (!record || record['k'] !== 'FillinLight') return {}
  const v = record['v']
  if (v === 1 || v === '1' || v === true) return { flash: true }
  if (v === 0 || v === '0' || v === false) return { flash: false }
  return {}
}

/** `10001/9` → `{ lightMode, lightLevel? }`: 101 is auto, 40..100 a manual level. */
export function decodeFillLightSet(raw: unknown): NavigationStatusPatch {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(n)) return {}
  if (n === FILL_LIGHT_AUTO) return { lightMode: 'auto' }
  if (n >= NAVIGATION_LIGHT_LEVEL_MIN && n <= NAVIGATION_LIGHT_LEVEL_MAX) {
    return { lightMode: 'manual', lightLevel: n }
  }
  return {}
}

/** The robot state that means "following a person" (`MiotState.Following`). */
export const MIOT_STATE_FOLLOWING = 26

/** `true` while the robot's own state says it is following; `null` state = not known. */
export function decodeFollowing(state: number | null | undefined): boolean | null {
  if (state === null || state === undefined || !Number.isFinite(state)) return null
  return state === MIOT_STATE_FOLLOWING
}

/** A property reader over the live handle: `getProperty(siid, piid)?.value`. */
export type PropertyReader = (siid: number, piid: number) => unknown

/** Everything the robot currently says about its light, as one patch. */
export function decodeNavigationReadback(read: PropertyReader): NavigationStatusPatch {
  return {
    ...decodeFillLight(read(FILL_LIGHT_SIID, FILL_LIGHT_PIID)),
    ...decodeFillLightSet(read(FILL_LIGHT_SET_SIID, FILL_LIGHT_SET_PIID)),
  }
}
