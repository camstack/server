/**
 * Identity edits collected by the device quick-detail modal. The modal saves
 * them with the other sections, from one button.
 */

export interface IdentityDraft {
  readonly name: string
  readonly location: string
  readonly baseName: string
  readonly baseLocation: string
}

/** Follow the server while the operator has not diverged; keep a dirty draft. */
export function seedIdentityDraft(
  prev: IdentityDraft | null,
  name: string,
  location: string,
): IdentityDraft {
  if (prev === null) return { name, location, baseName: name, baseLocation: location }
  const clean = prev.name === prev.baseName && prev.location === prev.baseLocation
  if (clean || (prev.name === name && prev.location === location)) {
    return { name, location, baseName: name, baseLocation: location }
  }
  return prev
}

export function identityDirty(draft: IdentityDraft | null): boolean {
  if (draft === null) return false
  return draft.name !== draft.baseName || draft.location !== draft.baseLocation
}

/** A cleared name cannot be saved. `null` means the draft may be written. */
export function identitySaveRefusal(draft: IdentityDraft): 'name' | null {
  if (draft.name.trim().length === 0) return 'name'
  return null
}

export interface QuickDetailSlice {
  readonly dirty: boolean
  readonly saving: boolean
  readonly error: string | null
}

export interface QuickDetailSaveState {
  readonly dirty: boolean
  readonly saving: boolean
  readonly error: string | null
}

/** One footer from every section: dirty if any is, the errors joined. */
export function quickDetailSaveState(slices: readonly QuickDetailSlice[]): QuickDetailSaveState {
  const errors = slices
    .map((slice) => slice.error)
    .filter((error): error is string => error !== null && error.length > 0)
  return {
    dirty: slices.some((slice) => slice.dirty),
    saving: slices.some((slice) => slice.saving),
    error: errors.length === 0 ? null : errors.join('; '),
  }
}
