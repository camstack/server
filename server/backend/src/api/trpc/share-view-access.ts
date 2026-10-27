/**
 * Share-view access checker — the fail-closed allowlist gate for share-link
 * share-token principals (grid rework R6).
 *
 * A share token authenticates as a RESTRICTED principal: it may call ONLY
 * the tRPC methods the standalone grid embed page actually needs, and only
 * for the deviceIds baked into its scope. Everything else — hand-written
 * core routes included — is FORBIDDEN. This is deliberately stricter than
 * the scoped-token path (which passes hand-written core routes
 * through): a share link is handed to third parties, so the surface is a
 * closed enumeration, not a capability grant.
 *
 * TWO enumerations, one per scope kind — `grid-view` (the camera wall) and
 * `events-view` (the events embed). Neither is a superset of the other, and
 * adding a method to one NEVER widens the other: a `grid-view` link an operator
 * handed out last week must not silently start serving event history because
 * a new surface shipped. A new perimeter needs a new mint.
 *
 * The grid enumeration mirrors the embed grid page's real call graph
 * (`packages/addon-pipeline/embed/src`, via `@camstack/sdk` +
 * `@camstack/ui-library` hooks):
 *   • `auth.me`                              — SDK boot/auth probe
 *   • `deviceManager.listAll`                — tile names/online state
 *   • `snapshot.getSnapshot`                 — cold-start tile poster
 *   • `webrtcSession.*` (signaling octet)    — WebRTC live view
 *   • `turnProvider.getTurnServers`          — browser-side ICE servers
 *   • `pipelineOrchestrator.getCameraMetrics`— stream overlay bootstrap
 *   • `live.onEvent`                         — motion/detection/audio
 *     highlight events (the stream itself is additionally device-filtered
 *     in `live-events.router.ts` via `liveEventInShareScope`)
 *
 * TALK-BACK is the one thing outside the enumeration that a token can carry,
 * and only because it asked at mint time (`scope.talk`). It is NOT in the grid
 * enumeration: a method added there is granted RETROACTIVELY to every token
 * ever minted, and the difference between watching the kitchen and speaking
 * into it must be a choice somebody made for that link. Three methods, named
 * one by one — `intercom.*` is not granted as a namespace — and still confined
 * to the token's own deviceIds.
 *
 * WHICH three matters, and the first cut got it wrong: the talk-back the embed
 * performs is the WEBRTC flow (`startSession` → `handleAnswer` → `stopSession`,
 * `embed/src/embed/use-exclusive-intercom.ts`), not the push-talk triple.
 * Granting push-talk would have shipped a flag that changed nothing — the disc
 * would have gone on being refused, and the refusal would have read as the
 * operator failing to tick a box.
 *
 * Intentionally NOT allowlisted: the rest of `intercom.*` (the listen half is
 * already served by `webrtcSession.*`), `recording.*`,
 * `snapshot.invalidateCache`, and every other cap/core method.
 *
 * Pure module — no tRPC machinery — so the spec exercises it directly
 * (same pattern as `scope-access.ts`).
 */
import type { ShareViewGrant } from '@camstack/types'

export type ShareViewAccessResult = { ok: true } | { ok: false; reason: string }

/**
 * Methods callable WITHOUT a per-device check — their input carries no
 * deviceId. `live.onEvent` is here because its input is only a category;
 * the pushed stream is device-filtered separately in the live router.
 */
const GRID_VIEW_OPEN_METHODS: ReadonlySet<string> = new Set([
  'auth.me',
  'deviceManager.listAll',
  'turnProvider.getTurnServers',
  'live.onEvent',
])

/**
 * Talk-back, callable only on a token minted with `scope.talk` AND only for an
 * in-scope deviceId. Enumerated, never `intercom.*`: a namespace grant here
 * would pick up whatever the cap grows next.
 */
const GRID_VIEW_TALK_METHODS: ReadonlySet<string> = new Set([
  'intercom.startSession',
  'intercom.handleAnswer',
  'intercom.stopSession',
])

/**
 * Methods callable ONLY with an in-scope `input.deviceId`. A missing or
 * non-numeric deviceId is denied (fail closed).
 */
const GRID_VIEW_DEVICE_METHODS: ReadonlySet<string> = new Set([
  'snapshot.getSnapshot',
  'pipelineOrchestrator.getCameraMetrics',
  'webrtcSession.listStreams',
  'webrtcSession.createSession',
  'webrtcSession.handleOffer',
  'webrtcSession.handleAnswer',
  'webrtcSession.addIceCandidate',
  'webrtcSession.getIceCandidates',
  'webrtcSession.getSessionState',
  'webrtcSession.closeSession',
])

/** Pull `deviceId` off a raw tRPC input without casting. */
function extractDeviceId(input: unknown): number | null {
  if (input === null || typeof input !== 'object') return null
  const candidate: unknown = Reflect.get(input, 'deviceId')
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null
}

/**
 * The EVENTS embed's real call graph (`events-client.ts` in the embed):
 *   • `auth.me`                                — SDK boot/auth probe
 *   • `deviceManager.listAll`                  — camera names + the "all
 *     cameras" resolution (already projected to the scope)
 *   • `pipelineAnalytics.listRecentTracks`     — the feed itself
 *   • `pipelineAnalytics.listEventKindsBatch`  — the class→macro taxonomy
 *   • `pipelineAnalytics.searchObjectEvents`   — CLIP text search
 *   • `pipelineAnalytics.getTrack` / `listTrackMedia` — the track detail page
 *
 * Intentionally NOT here: everything the grid link gets (WebRTC signalling,
 * snapshots, TURN, camera metrics) — a shared events page is not a camera
 * wall — and every mutating analytics method (`deleteTracks`, `setTrackFlags`,
 * the retrain surface, the export planes).
 */
const EVENTS_VIEW_OPEN_METHODS: ReadonlySet<string> = new Set(['auth.me', 'deviceManager.listAll'])

/**
 * Methods whose input carries a `deviceIds` ARRAY. The rule is INTERSECTION,
 * and the outcome is FILTER-AND-SERVE: a request that names at least one
 * in-scope device passes, and the RESPONSE is stripped to the scope by
 * {@link projectShareScopeRows}.
 *
 * Filter rather than reject, because a multi-camera link whose owner later
 * narrowed the share must keep working for the cameras it still covers —
 * rejecting the whole page would break the link on a change that only removed
 * one camera. A FULLY disjoint request is still denied: there is nothing to
 * serve, and answering `[]` would read as "these cameras had no events" rather
 * than "you cannot see these cameras".
 */
const EVENTS_VIEW_DEVICE_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'pipelineAnalytics.listRecentTracks',
  'pipelineAnalytics.listEventKindsBatch',
])

/**
 * Methods whose input carries an OPTIONAL single `deviceId`, where omitting it
 * means EVERY camera in the deployment.
 *
 * A present id must be in scope. An ABSENT id is allowed — and that is safe
 * only because the response is filtered server-side
 * ({@link projectShareScopeRows}); the caller is never trusted to have scoped
 * its own query. Rejecting the absent case instead would leave a multi-camera
 * share link unable to search at all, and would not be one bit safer.
 */
const EVENTS_VIEW_OPTIONAL_DEVICE_METHODS: ReadonlySet<string> = new Set([
  'pipelineAnalytics.searchObjectEvents',
])

/**
 * Methods that read ONE track (or its media manifest) and REQUIRE a single
 * numeric `input.deviceId` that is inside the scope. Used by the embed's track
 * detail page (`?mode=track`).
 *
 * Unlike {@link EVENTS_VIEW_OPTIONAL_DEVICE_METHODS} an absent id is DENIED
 * (fail closed): the answer is one row, not a list the response filter could
 * cut. The provider must return null when the stored track belongs to another
 * device than `input.deviceId` — the gate vouches for the id the caller named,
 * the provider vouches that it is the track's own.
 */
const EVENTS_VIEW_REQUIRED_DEVICE_METHODS: ReadonlySet<string> = new Set([
  'pipelineAnalytics.getTrack',
  'pipelineAnalytics.listTrackMedia',
])

/** Pull a `deviceIds` array off a raw tRPC input. Null when absent/malformed. */
function extractDeviceIds(input: unknown): readonly number[] | null {
  if (input === null || typeof input !== 'object') return null
  const candidate: unknown = Reflect.get(input, 'deviceIds')
  if (!Array.isArray(candidate)) return null
  const ids = candidate.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return ids.length === candidate.length ? ids : null
}

function checkEventsViewAccess(
  scope: ShareViewGrant,
  path: string,
  input?: unknown,
): ShareViewAccessResult {
  if (EVENTS_VIEW_OPEN_METHODS.has(path)) {
    return { ok: true }
  }
  if (EVENTS_VIEW_DEVICE_ARRAY_METHODS.has(path)) {
    const requested = extractDeviceIds(input)
    if (requested === null || requested.length === 0) {
      return { ok: false, reason: `'${path}' requires a deviceIds array for share-view access` }
    }
    const allowed = new Set(scope.deviceIds)
    if (!requested.some((id) => allowed.has(id))) {
      return {
        ok: false,
        reason: `Devices ${requested.join(', ')} are outside this share link's scope`,
      }
    }
    return { ok: true }
  }
  if (EVENTS_VIEW_OPTIONAL_DEVICE_METHODS.has(path)) {
    const deviceId = extractDeviceId(input)
    // Absent = every camera; the RESPONSE filter is what scopes it.
    if (deviceId === null) return { ok: true }
    if (!scope.deviceIds.includes(deviceId)) {
      return { ok: false, reason: `Device ${deviceId} is outside this share link's scope` }
    }
    return { ok: true }
  }
  if (EVENTS_VIEW_REQUIRED_DEVICE_METHODS.has(path)) {
    const deviceId = extractDeviceId(input)
    if (deviceId === null) {
      return { ok: false, reason: `'${path}' requires a numeric deviceId for share-view access` }
    }
    if (!scope.deviceIds.includes(deviceId)) {
      return { ok: false, reason: `Device ${deviceId} is outside this share link's scope` }
    }
    return { ok: true }
  }
  return { ok: false, reason: `'${path}' is not available to share-view tokens` }
}

export function checkShareViewAccess(
  scope: ShareViewGrant,
  path: string,
  input?: unknown,
): ShareViewAccessResult {
  if (scope.kind === 'events-view') {
    return checkEventsViewAccess(scope, path, input)
  }
  if (scope.kind !== 'grid-view') {
    return { ok: false, reason: `Unknown share scope kind '${String(scope.kind)}'` }
  }
  if (GRID_VIEW_OPEN_METHODS.has(path)) {
    return { ok: true }
  }
  // Talk-back BEFORE the device enumeration, because it is the one gate that
  // can refuse for a reason other than the device: a token that never asked
  // for it must be told that, not told its camera is out of scope.
  if (GRID_VIEW_TALK_METHODS.has(path)) {
    if (scope.talk !== true) {
      return { ok: false, reason: `'${path}' needs a share link minted with talk-back` }
    }
  }
  if (GRID_VIEW_TALK_METHODS.has(path) || GRID_VIEW_DEVICE_METHODS.has(path)) {
    const deviceId = extractDeviceId(input)
    if (deviceId === null) {
      return { ok: false, reason: `'${path}' requires a numeric deviceId for share-view access` }
    }
    if (!scope.deviceIds.includes(deviceId)) {
      return {
        ok: false,
        reason: `Device ${deviceId} is outside this share link's scope`,
      }
    }
    return { ok: true }
  }
  return { ok: false, reason: `'${path}' is not available to share-view tokens` }
}

/**
 * Whitelisted `deviceManager.listAll` row for share-view principals —
 * exactly what the embed grid tiles read (id/name/online + a little
 * harmless presentation state). NOTHING else: the full listAll row
 * carries `config` with connection hosts and CREDENTIALS, and metadata
 * of every device in the deployment.
 */
interface ShareViewDeviceRow {
  readonly id: number
  readonly name: unknown
  readonly online: unknown
  readonly isCamera: unknown
  readonly type: unknown
  readonly location: unknown
  readonly disabled: unknown
}

/**
 * Output filter for `deviceManager.listAll` under a share-view principal:
 * drop every device outside the token's scope, and project the survivors
 * onto the whitelisted row (never the raw device — fail closed on fields).
 * Non-array payloads pass through untouched (the route errored upstream).
 */
export function projectListAllForShareScope(data: unknown, scope: ShareViewGrant): unknown {
  return projectListAllForDeviceIds(data, new Set<number>(scope.deviceIds))
}

/**
 * The projection ENGINE: drop every `listAll` row whose id is not in
 * `allowed`, and project the survivors onto the whitelisted row.
 *
 * Shared by the share-link path ({@link projectListAllForShareScope}) and
 * the scoped-principal path (`projectListAllForPrincipal` in
 * `principal-visibility.ts`) so enumeration is cut ONE way. Two projectors
 * would be two chances to forget `config` — which carries the camera
 * credentials in plaintext.
 */
export function projectListAllForDeviceIds(data: unknown, allowed: ReadonlySet<number>): unknown {
  if (!Array.isArray(data)) return data
  const rows: ShareViewDeviceRow[] = []
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    const id: unknown = Reflect.get(entry, 'id')
    if (typeof id !== 'number' || !allowed.has(id)) continue
    rows.push({
      id,
      name: Reflect.get(entry, 'name'),
      online: Reflect.get(entry, 'online'),
      isCamera: Reflect.get(entry, 'isCamera'),
      type: Reflect.get(entry, 'type'),
      location: Reflect.get(entry, 'location'),
      disabled: Reflect.get(entry, 'disabled'),
    })
  }
  return rows
}

/**
 * Strip every row a share token may not see, by `deviceId`.
 *
 * This is the half that makes the events surface safe, and it is not
 * defence-in-depth — it is the ACTUAL enforcement for two of the three
 * methods:
 *
 *  - `searchObjectEvents` with no `deviceId` searches the whole deployment.
 *    The call is allowed (see the enumeration) precisely because the answer is
 *    cut here; trusting the caller to scope its own query would be trusting a
 *    URL a third party is holding.
 *  - `listRecentTracks` / `listEventKindsBatch` pass the intersection check, so
 *    a partially in-scope request reaches the provider — and comes back with
 *    rows the link may not see. Those are removed here.
 *
 * Two payload shapes, because the methods answer differently: a bare array of
 * rows (`searchObjectEvents`, `listEventKindsBatch`) and a PAGED envelope
 * (`listRecentTracks` → `{tracks, nextCursor}`). The cursor is preserved —
 * dropping it would silently end a shared page's infinite scroll at page one.
 *
 * A row with NO numeric `deviceId` is DROPPED, never kept: "it probably
 * belongs to a device in scope" is not a security argument.
 *
 * Anything that is not a row payload passes through untouched (the route
 * errored upstream, and rewriting an error into `[]` would hide it).
 */
export function projectShareScopeRows(data: unknown, scope: ShareViewGrant): unknown {
  const allowed = new Set<number>(scope.deviceIds)
  const keep = (row: unknown): boolean => {
    if (row === null || typeof row !== 'object') return false
    const id: unknown = Reflect.get(row, 'deviceId')
    return typeof id === 'number' && allowed.has(id)
  }
  if (Array.isArray(data)) return data.filter(keep)
  if (data !== null && typeof data === 'object') {
    const tracks: unknown = Reflect.get(data, 'tracks')
    if (Array.isArray(tracks)) {
      return { ...(data as Record<string, unknown>), tracks: tracks.filter(keep) }
    }
  }
  return data
}

/** Paths whose RESPONSE must be cut to the share scope before it leaves the
 *  server. Kept beside the enumeration so a method added to one and forgotten
 *  in the other is visible in a single file. */
export const SHARE_SCOPE_PROJECTED_METHODS: ReadonlySet<string> = new Set([
  'pipelineAnalytics.listRecentTracks',
  'pipelineAnalytics.listEventKindsBatch',
  'pipelineAnalytics.searchObjectEvents',
])

/**
 * Event shape the live-events stream filter needs — structurally matches
 * the events `EventBusService.subscribe` pushes.
 */
export interface ShareFilterableEvent {
  readonly source?: { readonly type?: string; readonly id?: string | number }
  readonly data?: Record<string, unknown>
}

/**
 * Whether a live event belongs to a device inside the share scope.
 * Matches the device identity two ways (fail closed — no match, no push):
 *   • `source.id` — device-sourced events (motion, detection, audio);
 *     tolerates the string-typed ids some emitters use;
 *   • `data.deviceId` — addon-sourced per-device telemetry
 *     (e.g. `pipeline.camera-metrics-snapshot`).
 */
export function liveEventInShareScope(
  evt: ShareFilterableEvent,
  allowedDeviceIds: ReadonlySet<number>,
): boolean {
  const sourceId = evt.source?.id
  if (typeof sourceId === 'number' && allowedDeviceIds.has(sourceId)) return true
  if (typeof sourceId === 'string' && sourceId !== '') {
    const numeric = Number(sourceId)
    if (Number.isInteger(numeric) && allowedDeviceIds.has(numeric)) return true
  }
  const dataDeviceId = evt.data?.['deviceId']
  if (typeof dataDeviceId === 'number' && allowedDeviceIds.has(dataDeviceId)) return true
  return false
}
