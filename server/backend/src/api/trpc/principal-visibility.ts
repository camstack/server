/**
 * Non-admin principal device visibility — the shared answer to "which cameras
 * may this scoped caller see?", reused by two hotfixes:
 *
 *   - F0.4 `auth.mintToken` (a share-view grant) — a scoped user must not mint a share link
 *     share token for a device it cannot see. The requested deviceIds are
 *     INTERSECTED with what the caller can view.
 *   - F0.5 the event firehose (`live.onEvent`, `systemEvents.subscribe`, …) —
 *     a device-restricted scoped token must not receive every camera's motion /
 *     detection events. Its stream is filtered to the devices it can view.
 *
 * The single source of truth for "can this principal VIEW device D" is the
 * existing scope matcher ({@link checkScopeAccess}) run against a canonical
 * device-scope VIEW method. Reusing the matcher means share minting and event
 * filtering agree with the middleware that gates the per-camera surfaces
 * themselves — including `device:[parent]` → child-accessory inheritance via
 * the ancestor walk.
 *
 * Pure module — no tRPC machinery — so the spec exercises it directly (same
 * pattern as `scope-access.ts` / `share-view-access.ts`).
 */
import { METHOD_ACCESS_MAP } from '@camstack/system'
import type { CredentialScope, DeviceMetaLike, UserScope } from '@camstack/types'
import { capabilityScopesOf, resolveViewableDeviceIds, viewerScopeOf } from '@camstack/types'
import { personSessionScopes } from '../../auth/person-session-scopes.js'
import { checkScopeAccess, type DeviceScopeLookup } from './scope-access.js'
import { projectListAllForDeviceIds, type ShareFilterableEvent } from './share-view-access.js'

/**
 * Canonical "view this camera" probe. `snapshot.getSnapshot` is a device-scope,
 * `view`-access method every viewer surface needs (the grid-embed cold-start
 * tile), so a caller who can pass its scope check is a caller who can see the
 * camera. A rename is caught at import time by {@link assertProbeExists} — a
 * loud boot failure, never a silent "deny everyone".
 */
const DEVICE_VIEW_PROBE = 'snapshot.getSnapshot'

function assertProbeExists(): void {
  const meta = METHOD_ACCESS_MAP[DEVICE_VIEW_PROBE]
  if (!meta || meta.capScope !== 'device' || meta.access !== 'view') {
    throw new Error(
      `principal-visibility: probe '${DEVICE_VIEW_PROBE}' is not a device-scope view method ` +
        `(codegen drift). Pick another canonical camera-view method.`,
    )
  }
}
assertProbeExists()

/**
 * True when the scoped principal may VIEW device `deviceId`. Handles
 * `device:[parent]` → child inheritance through the ancestor walk, exactly as
 * the per-camera middleware does.
 */
export function callerCanViewDevice(
  scopes: readonly UserScope[],
  deviceId: number,
  lookup?: DeviceScopeLookup,
): boolean {
  return checkScopeAccess(scopes, DEVICE_VIEW_PROBE, { deviceId }, lookup).ok
}

/**
 * A scoped principal sees the WHOLE event/telemetry firehose when it holds any
 * `category`-scope view grant — the operator / family-viewer tiers, whose whole
 * purpose is a broad read. A token scoped only to specific `device:[…]` (or a
 * single `capability`/`addon`) is NOT broad: its event stream is filtered to the
 * devices it can view, and unattributable events are dropped (fail closed).
 *
 * Kept deliberately separate from {@link callerCanViewDevice}: a
 * `category:system` operator legitimately monitors the system dashboard, so
 * gating their event stream to a device-scope probe (which `category:system`
 * does not satisfy) would blank a surface they are entitled to. Availability and
 * security both point the same way here — broad grant, broad stream.
 */
export function isBroadEventViewer(scopes: readonly UserScope[]): boolean {
  // A viewer (D921) sees the firehose only with every device admitted; any
  // other row it carries never counts.
  const viewer = viewerScopeOf(scopes)
  if (viewer !== null) return viewer.allow === '*' && viewer.block.length === 0
  return scopes.some((s) => s.type === 'category' && s.access.includes('view'))
}

/**
 * Filter a requested deviceId list down to those the caller may view. Used by
 * share minting: an admin passes `isAdmin` and skips this; a non-admin gets the
 * intersection, and the router refuses when it is empty.
 */
export function filterViewableDeviceIds(
  scopes: readonly UserScope[],
  requested: readonly number[],
  lookup?: DeviceScopeLookup,
): number[] {
  return requested.filter((id) => callerCanViewDevice(scopes, id, lookup))
}

/** The device identity an event is attributable to, or null when it carries
 *  none. Mirrors `liveEventInShareScope`'s matching (source.id, source.deviceId,
 *  data.deviceId) so scoped filtering and share filtering agree. */
function eventDeviceId(evt: ShareFilterableEvent): number | null {
  const sourceId = evt.source?.id
  if (typeof sourceId === 'number' && Number.isFinite(sourceId)) return sourceId
  if (typeof sourceId === 'string' && sourceId !== '') {
    const n = Number(sourceId)
    if (Number.isInteger(n)) return n
  }
  const src = evt.source as { deviceId?: unknown } | undefined
  if (typeof src?.deviceId === 'number' && Number.isFinite(src.deviceId)) return src.deviceId
  const dataDeviceId = evt.data?.['deviceId']
  if (typeof dataDeviceId === 'number' && Number.isFinite(dataDeviceId)) return dataDeviceId
  return null
}

/**
 * True when the principal's device reach is UNRESTRICTED at view — admin, a
 * `category:device[view]` grant, or a device grant with an `all` selector.
 * Such a caller enumerates the fleet unprojected, exactly as before.
 */
export function hasUnrestrictedDeviceView(isAdmin: boolean, scopes: readonly UserScope[]): boolean {
  if (isAdmin) return true
  // A viewer (D921) is unrestricted only with every device allowed and none
  // blocked; the rest of its set never counts.
  const viewer = viewerScopeOf(scopes)
  if (viewer !== null) return viewer.allow === '*' && viewer.block.length === 0
  return scopes.some(
    (s) =>
      (s.type === 'category' && s.target === 'device' && s.access.includes('view')) ||
      (s.type === 'device' && s.selector.kind === 'all' && s.access.includes('view')),
  )
}

/**
 * Cut a `deviceManager.listAll` payload to the devices this principal may VIEW
 * (F1 #4 — "enumerate only mine").
 *
 * A device outside the scope is INVISIBLE in enumerations (operator decision),
 * not merely un-openable: returning it would leak the deployment's camera
 * names, locations and online state to a token granted one camera.
 *
 * Reuses `resolveViewableDeviceIds` (the same selector engine the matcher
 * uses, so enumeration and by-id access can never disagree) and
 * `projectListAllForDeviceIds` (the same row whitelist the share path uses, so
 * neither surface can forget that `config` carries credentials).
 *
 * A caller with unrestricted reach is returned the payload untouched.
 */
export function projectListAllForPrincipal(
  data: unknown,
  isAdmin: boolean,
  scopes: readonly UserScope[],
  fleet: readonly DeviceMetaLike[],
): unknown {
  if (hasUnrestrictedDeviceView(isAdmin, scopes)) return data
  const viewable = resolveViewableDeviceIds(scopes, fleet, 'view')
  return projectListAllForDeviceIds(data, viewable)
}

/** The minimal principal shape the event filter needs. */
export interface EventPrincipal {
  readonly isAdmin: boolean
  /** A signed-in person. Their firehose follows the viewer row alone. */
  readonly interactive?: boolean
  readonly scopes?: readonly CredentialScope[]
}

/** Grant rows a principal is decided by. A person contributes only its viewer row. */
function decisionScopes(user: EventPrincipal): readonly UserScope[] {
  const raw = user.scopes ?? []
  const scopes = user.interactive === true ? personSessionScopes(raw) : raw
  return capabilityScopesOf(scopes)
}

/**
 * Build the event-stream predicate for a NON-share principal (F0.5).
 *
 * Returns `null` when the principal sees the whole firehose — an admin, or a
 * broad `category`-view operator (see {@link isBroadEventViewer}). Otherwise a
 * predicate that keeps only events attributable to a device the principal may
 * view; an event with NO device identity is DROPPED (fail closed — "probably in
 * scope" is not a security argument).
 *
 * Share-view principals are NOT handled here — they keep their own,
 * stricter `liveEventInShareScope` filter, applied by the routers first.
 */
export function scopedEventVisibility(
  user: EventPrincipal,
  lookup?: DeviceScopeLookup,
): ((evt: ShareFilterableEvent) => boolean) | null {
  if (user.isAdmin) return null
  const scopes = decisionScopes(user)
  if (isBroadEventViewer(scopes)) return null
  return (evt) => {
    const id = eventDeviceId(evt)
    if (id === null) return false
    return callerCanViewDevice(scopes, id, lookup)
  }
}
