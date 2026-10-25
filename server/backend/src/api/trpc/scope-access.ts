/**
 * Pure scope-access matcher.
 *
 * Extracted from `trpc.middleware.ts` so the spec can exercise it
 * without spinning up the tRPC initTRPC machinery. The function is
 * stateless aside from an optional {@link DeviceScopeLookup}.
 *
 * Algorithm (v3 — four scope types):
 *   1. Look the tRPC `path` up in `METHOD_ACCESS_MAP`. Unknown =
 *      FORBIDDEN (codegen drift; fail closed).
 *   2. For each scope on the caller, check if it matches:
 *      - `category`   — scope.target matches meta.capScope ('device'|'system')
 *      - `capability` — scope.target matches meta.capName exactly
 *      - `addon`      — scope.target matches meta.addonId (when set)
 *      - `device`     — the request's `input.deviceId` is covered by the
 *                       grant's v3 `selector` (all / ids / types / locations),
 *                       resolved against the device's persisted type/location
 *                       via {@link DeviceScopeLookup}. When the grant inherits
 *                       (view by default, or `includeLinked`), an ANCESTOR
 *                       match also covers the device — granting a Reolink
 *                       camera implicitly grants its siren / floodlight / PIR
 *                       children without re-listing them.
 *   3. On a target match, accept iff `scope.access` includes the
 *      method's required `access` flavour.
 *   4. No matching scope → FORBIDDEN with a human-readable reason.
 */
import { METHOD_ACCESS_MAP } from '@camstack/system'
import type {
  DeviceMetaLike,
  DeviceTokenScope,
  MethodAccess,
  UserScope,
  ViewerTokenScope,
} from '@camstack/types'
import {
  deviceSelectorMatches,
  featureOfRole,
  METHOD_DEVICE_SELECTORS,
  scopeInherits,
  viewerAdmitsDevice,
  viewerHoldsRole,
  viewerScopeOf,
} from '@camstack/types'

export type ScopeAccessResult = { ok: true; access: MethodAccess } | { ok: false; reason: string }

/**
 * Resolves a deviceId to its ancestor chain (parent, grandparent, …).
 * Empty / omitted for top-level devices. Order is irrelevant — the
 * matcher only checks set membership.
 */
export type DeviceAncestorLookup = (deviceId: number) => readonly number[]

/**
 * The device metadata the v3 selector matcher needs, resolved synchronously
 * from the hub-process persisted mirror (never a fallible per-request read —
 * D49). `getAncestors` drives parent → child inheritance; `getType` /
 * `getLocation` resolve `types` / `locations` selectors. A missing metadatum
 * (device unknown to the mirror) reads as no-match — fail closed.
 */
export interface DeviceScopeLookup {
  getAncestors: DeviceAncestorLookup
  getType: (deviceId: number) => string | null
  getLocation: (deviceId: number) => string | null
}

/**
 * Pull `deviceId` off a tRPC request input. Device-scope cap methods
 * uniformly take `{deviceId: number, ...}` per the DeviceProxy contract,
 * so a single extractor covers every device-scope call. Returns null when
 * the input doesn't carry a deviceId (system-scope cap, void input, …).
 */
function extractDeviceId(input: unknown): number | null {
  if (input === null || typeof input !== 'object') return null
  const candidate = (input as Record<string, unknown>)['deviceId']
  return typeof candidate === 'number' ? candidate : null
}

/**
 * The device candidates a request is matched against: the deviceId itself
 * plus (when the grant inherits) its ancestors, each carrying the metadata a
 * v3 selector needs. A parent camera whose grant inherits therefore covers an
 * accessory child, because the child's request tests the grant against the
 * PARENT's metadata too.
 */
function candidateMetas(
  deviceId: number,
  lookup: DeviceScopeLookup | undefined,
): readonly DeviceMetaLike[] {
  const toMeta = (id: number): DeviceMetaLike => ({
    id,
    type: lookup?.getType(id) ?? '',
    location: lookup?.getLocation(id) ?? null,
    parentDeviceId: null,
  })
  if (!lookup) return [toMeta(deviceId)]
  const out: DeviceMetaLike[] = [toMeta(deviceId)]
  for (const ancestor of lookup.getAncestors(deviceId)) out.push(toMeta(ancestor))
  return out
}

/** Whether a v3 `device` grant covers this request. Direct selector match on
 *  the device, or — when the grant inherits at this access — a match on an
 *  ancestor. */
function deviceScopeCovers(
  scope: DeviceTokenScope,
  access: MethodAccess,
  candidates: readonly DeviceMetaLike[],
): boolean {
  const inherit = scopeInherits(scope, access)
  return candidates.some((cand, index) => {
    // index 0 is the device itself (always eligible); ancestors only when the
    // grant inherits.
    if (index > 0 && !inherit) return false
    return deviceSelectorMatches(scope.selector, cand)
  })
}

/** Render a device selector for the human-readable denial reason. */
function describeSelector(scope: DeviceTokenScope): string {
  const sel = scope.selector
  switch (sel.kind) {
    case 'all':
      return 'all'
    case 'ids':
      return `ids:${sel.ids.join(',')}`
    case 'types':
      return `types:${sel.types.join(',')}`
    case 'locations':
      return `locations:${sel.locations.join(',')}`
  }
}

/**
 * Methods that ENUMERATE devices rather than naming one — "which devices are
 * mine". A `device`-selector grant may reach these, and it is safe ONLY
 * because every one of them has its response cut to the caller's viewable set
 * before it leaves the server (`projectListAllForPrincipal`, applied in
 * `trpc.middleware.ts`).
 *
 * Adding a path here WITHOUT adding its projection hands the whole fleet to a
 * one-camera token. The pairing is asserted by
 * `scoped-list-projection.spec.ts`.
 */
export const DEVICE_ENUMERATION_METHODS: ReadonlySet<string> = new Set(['deviceManager.listAll'])

/**
 * Every deviceId a request NAMES, per the codegen'd
 * {@link METHOD_DEVICE_SELECTORS}. Absent / null / malformed values are
 * skipped: an optional `deviceId` that was not sent references no device, and
 * `linkDeviceId: null` means "clear the link".
 *
 * Exported because the tRPC `onError` logger needs the same answer: a refusal
 * on a device-scoped path has to say WHICH camera
 * (`trpc-error-device-tags.ts`).
 */
export function referencedDeviceIds(path: string, input: unknown): readonly number[] {
  const fields = METHOD_DEVICE_SELECTORS[path]
  if (!fields || input === null || typeof input !== 'object') return []
  const out: number[] = []
  for (const field of fields) {
    const raw: unknown = Reflect.get(input, field.name)
    if (raw === undefined || raw === null) continue
    if (field.form === 'single') {
      if (typeof raw === 'number' && Number.isFinite(raw)) out.push(raw)
      continue
    }
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (field.form === 'object-array') {
        // `targets[].deviceId` & co. — one nesting level, by design.
        if (item !== null && typeof item === 'object') {
          const nested: unknown = Reflect.get(item, field.itemField ?? 'deviceId')
          if (typeof nested === 'number' && Number.isFinite(nested)) out.push(nested)
        }
        continue
      }
      if (typeof item === 'number' && Number.isFinite(item)) out.push(item)
    }
  }
  return out
}

/**
 * True when the caller's device reach at `access` is UNRESTRICTED — admin-like
 * breadth expressed as `category:device[access]` or a `device` grant whose
 * selector is `all`. Such a caller is unaffected by the device-reference gate.
 */
function hasUnrestrictedDeviceReach(scopes: readonly UserScope[], access: MethodAccess): boolean {
  return scopes.some(
    (s) =>
      (s.type === 'category' && s.target === 'device' && s.access.includes(access)) ||
      (s.type === 'device' && s.selector.kind === 'all' && s.access.includes(access)),
  )
}

/**
 * The device-reference gate for SYSTEM-scope cap methods (F1 #3).
 *
 * ~124 system-scope methods take a deviceId (`recordingArchive.getDeviceConfig`,
 * `faceGallery.*`, `pipelineOrchestrator.*`, …) and were never device-filtered:
 * the matcher only extracted a deviceId when the CAP was `scope: 'device'`. So
 * a non-admin holding `category:system[view]` could read ANY camera's
 * recordings or faces regardless of the cameras they were granted. This closes
 * that.
 *
 * Applied ONLY to system-scope caps, and only ON TOP of an already-passing
 * cap-level grant — it never grants anything, it only subtracts. Device-scope
 * caps are deliberately untouched: there the `device` scope branch IS the
 * device check, and `capability:<name>` grants over device caps are
 * cross-device by documented design (the `events` cap, which the
 * `event-listener` preset depends on, is one). Making capability grants
 * device-restricted on device caps too is a separate, operator-visible
 * decision — not smuggled in here.
 */
function deviceRefsSatisfied(
  scopes: readonly UserScope[],
  path: string,
  input: unknown,
  access: MethodAccess,
  lookup: DeviceScopeLookup | undefined,
): { ok: true } | { ok: false; deviceId: number } {
  const refs = referencedDeviceIds(path, input)
  if (refs.length === 0) return { ok: true }
  if (hasUnrestrictedDeviceReach(scopes, access)) return { ok: true }
  const grants = scopes.filter(
    (s): s is DeviceTokenScope => s.type === 'device' && s.access.includes(access),
  )
  for (const deviceId of refs) {
    const candidates = candidateMetas(deviceId, lookup)
    const covered = grants.some((g) => deviceScopeCovers(g, access, candidates))
    if (!covered) return { ok: false, deviceId }
  }
  return { ok: true }
}

/**
 * The viewer role's matcher (D921). The method's ROLE decides what a viewer
 * may call (`viewer` baseline, `feature:<id>` when granted, never `admin`),
 * and every device the request names must be admitted by the viewer's
 * allow/block lists — through itself or an ancestor, with unknown parentage
 * failing closed (`viewerAdmitsDevice`). A method that names no device is
 * cross-device by nature (an enumeration, a gallery): its answer is cut where
 * one exists (`DEVICE_ENUMERATION_METHODS`, the event firehose filter).
 */
function checkViewerAccess(
  viewer: ViewerTokenScope,
  path: string,
  input: unknown,
  lookup: DeviceScopeLookup | undefined,
): ScopeAccessResult {
  const meta = METHOD_ACCESS_MAP[path]
  if (!meta) return { ok: false, reason: `Unknown method '${path}' — codegen drift` }
  if (!viewerHoldsRole(viewer, meta.role)) {
    const feature = featureOfRole(meta.role)
    return {
      ok: false,
      reason:
        feature !== null
          ? `'${path}' needs the '${feature}' feature, which this viewer does not have`
          : `'${path}' is for administrators — a viewer cannot call it`,
    }
  }
  const ancestors =
    lookup === undefined
      ? undefined
      : (id: number): readonly number[] | null =>
          lookup.getType(id) === null ? null : lookup.getAncestors(id)
  for (const deviceId of referencedDeviceIds(path, input)) {
    if (!viewerAdmitsDevice(viewer, deviceId, ancestors)) {
      return { ok: false, reason: `Device ${deviceId} is outside this viewer's devices` }
    }
  }
  return { ok: true, access: meta.access }
}

export function checkScopeAccess(
  scopes: readonly UserScope[],
  path: string,
  input?: unknown,
  lookup?: DeviceScopeLookup,
): ScopeAccessResult {
  // A viewer is decided by its own rules, alone (D921).
  const viewer = viewerScopeOf(scopes)
  if (viewer !== null) return checkViewerAccess(viewer, path, input, lookup)
  const meta = METHOD_ACCESS_MAP[path]
  if (!meta) {
    return { ok: false, reason: `Unknown method '${path}' — codegen drift` }
  }
  const deviceId = meta.capScope === 'device' ? extractDeviceId(input) : null
  for (const s of scopes) {
    let targetMatches = false
    switch (s.type) {
      case 'category':
        targetMatches = s.target === meta.capScope
        break
      case 'capability':
        targetMatches = s.target === meta.capName
        break
      case 'addon':
        targetMatches = meta.addonId !== null && s.target === meta.addonId
        break
      case 'device': {
        // A device grant matches either:
        //  • a request NAMING devices — in ANY shape the selector codegen
        //    recorded (top-level `deviceId`, `deviceIds[]`, or one-level
        //    nested `targets[].deviceId`) — when the v3 selector covers
        //    EVERY referenced device (or an ancestor, when the grant
        //    inherits). A single uncovered reference fails the call closed:
        //    the viewer's batches are built from its already-projected
        //    camera list, so a legit client never trips this, and a
        //    one-camera token cannot launder the fleet through an array.
        //  • a DEVICE ENUMERATION method, which names no device precisely
        //    because it asks "which are mine". Those are safe to reach ONLY
        //    because the RESPONSE is cut to the caller's set (see
        //    `DEVICE_ENUMERATION_METHODS`); without that projection this
        //    branch would hand the whole fleet to a one-camera token.
        const refs = meta.capScope === 'device' ? referencedDeviceIds(path, input) : []
        targetMatches =
          refs.length > 0
            ? refs.every((id) => deviceScopeCovers(s, meta.access, candidateMetas(id, lookup)))
            : DEVICE_ENUMERATION_METHODS.has(path)
        break
      }
      case 'viewer':
        // Unreachable: a viewer row is decided above, alone.
        continue
    }
    if (!targetMatches) continue
    if (!s.access.includes(meta.access)) continue
    // Cap-level grant passes. A SYSTEM-scope method that NAMES devices must
    // additionally be covered on each of them — otherwise `category:system`
    // reads every camera's recordings (F1 #3).
    if (meta.capScope === 'system') {
      const refs = deviceRefsSatisfied(scopes, path, input, meta.access, lookup)
      if (!refs.ok) {
        return {
          ok: false,
          reason: `Device ${refs.deviceId} is outside your device scope (referenced by '${path}')`,
        }
      }
    }
    return { ok: true, access: meta.access }
  }
  return {
    ok: false,
    reason: `No scope grants ${meta.access} on '${meta.capName}' (${meta.capScope}-scope cap${
      deviceId !== null ? `, device=${deviceId}` : ''
    }). Have: ${
      scopes
        .map((s) => {
          if (s.type === 'viewer') return 'viewer'
          const target = s.type === 'device' ? `[${describeSelector(s)}]` : s.target
          return `${s.type}:${target}[${s.access.join(',')}]`
        })
        .join(', ') || '(none)'
    }`,
  }
}
