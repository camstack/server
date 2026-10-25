/**
 * The role modal's model (D921, amended 2026-10-24): a person is an ADMIN or a
 * VIEWER, and a viewer is ONE device list in one mode plus named features.
 *
 *   - "All devices except…" stores `allow: '*'`, `block: <picked>`. Nothing
 *     picked means every device.
 *   - "Only these devices…" stores `allow: <picked>`, `block: []`. An empty
 *     list cannot be saved.
 *
 * Switching mode keeps the picked ids. A stored row that is BOTH an allow
 * list AND a non-empty block is not representable: it reads as "only" with
 * `allow` minus `block`.
 *
 * Pure — no React, no I/O — so every decision the modal makes about what it
 * will SAVE is pinned by a unit spec rather than by clicking.
 */
import {
  DEFAULT_VIEWER_SCOPE,
  viewerScopeOf,
  type UserScope,
  type ViewerFeatureId,
  type ViewerTokenScope,
} from '@camstack/types'

/** Which list the one picker edits. */
export type ViewerDeviceMode = 'except' | 'only'

/** The two roles a person can hold. */
export type RoleChoice = 'admin' | 'viewer'

/** The modal's whole draft — one object, so a role switch cannot half-apply. */
export interface RoleDraft {
  readonly role: RoleChoice
  readonly mode: ViewerDeviceMode
  /** The ids in the picker. The same list survives a mode switch. */
  readonly pickedIds: readonly number[]
  /** The viewer row this draft would save, kept while Admin is picked. */
  readonly viewer: ViewerTokenScope
  /** A non-admin nobody has given a viewer row yet. */
  readonly unconfigured: boolean
}

/** What a Save writes: the admin flag, then the scope set. */
export interface RoleSaveRequest {
  readonly isAdmin: boolean
  readonly scopes: readonly UserScope[]
}

/** Why a draft cannot be saved, or `null` when it can. */
export type RoleInvalidReason = 'no-allowed-device' | null

/** The parts of a user the model reads. */
export interface RoleSubject {
  readonly isAdmin: boolean
  readonly scopes?: readonly UserScope[]
}

/** Read a stored user back into a draft. */
export function draftFromUser(user: RoleSubject): RoleDraft {
  const viewer = viewerScopeOf(user.scopes ?? [])
  if (viewer === null) {
    return {
      role: user.isAdmin ? 'admin' : 'viewer',
      mode: 'except',
      pickedIds: [],
      viewer: DEFAULT_VIEWER_SCOPE,
      unconfigured: !user.isAdmin,
    }
  }
  const choice = choiceOf(viewer)
  return {
    role: user.isAdmin ? 'admin' : 'viewer',
    mode: choice.mode,
    pickedIds: choice.pickedIds,
    viewer: rowOf(choice.mode, choice.pickedIds, viewer.features),
    unconfigured: false,
  }
}

/** Pick Admin or Viewer. The device draft is kept either way. */
export function withRole(draft: RoleDraft, role: RoleChoice): RoleDraft {
  return { ...draft, role }
}

/** Switch mode. The picked ids stay; only what they MEAN changes. */
export function withMode(draft: RoleDraft, mode: ViewerDeviceMode): RoleDraft {
  return {
    ...draft,
    mode,
    viewer: rowOf(mode, draft.pickedIds, draft.viewer.features),
  }
}

/** Replace the picked ids. */
export function withPickedIds(draft: RoleDraft, ids: readonly number[]): RoleDraft {
  const pickedIds = uniqueIds(ids)
  return { ...draft, pickedIds, viewer: rowOf(draft.mode, pickedIds, draft.viewer.features) }
}

/** Grant or withdraw one named feature. */
export function withFeature(draft: RoleDraft, id: ViewerFeatureId, on: boolean): RoleDraft {
  const rest = draft.viewer.features.filter((feature) => feature !== id)
  const features = on ? [...rest, id] : rest
  return { ...draft, viewer: rowOf(draft.mode, draft.pickedIds, features) }
}

/** Why Save is refused for this draft, or `null`. */
export function invalidReasonOf(draft: RoleDraft): RoleInvalidReason {
  if (draft.role === 'viewer' && draft.mode === 'only' && draft.pickedIds.length === 0) {
    return 'no-allowed-device'
  }
  return null
}

/** What Save writes, or `null` when the draft is not saveable. */
export function saveRequestOf(draft: RoleDraft): RoleSaveRequest | null {
  if (invalidReasonOf(draft) !== null) return null
  if (draft.role === 'admin') return { isAdmin: true, scopes: [] }
  return { isAdmin: false, scopes: [draft.viewer] }
}

interface StoredDeviceChoice {
  readonly mode: ViewerDeviceMode
  readonly pickedIds: readonly number[]
}

/**
 * The one way a stored row is shown. `allow: '*'` is "except". An allow list
 * is "only", and a block beside it is subtracted — that combination has no
 * mode of its own.
 */
function choiceOf(scope: ViewerTokenScope): StoredDeviceChoice {
  if (scope.allow === '*') return { mode: 'except', pickedIds: scope.block }
  const blocked = new Set(scope.block)
  return { mode: 'only', pickedIds: scope.allow.filter((id) => !blocked.has(id)) }
}

function rowOf(
  mode: ViewerDeviceMode,
  ids: readonly number[],
  features: readonly ViewerFeatureId[],
): ViewerTokenScope {
  const picked = uniqueIds(ids)
  if (mode === 'except')
    return { type: 'viewer', allow: '*', block: picked, features: [...features] }
  return { type: 'viewer', allow: picked, block: [], features: [...features] }
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)]
}
