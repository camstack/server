/**
 * Identity and display edits collected by the device page's one Save — the
 * same footer the quick-detail modal uses. Name, room, role and the display
 * override (icon, label, unit, precision, hidden) wait here; nothing writes
 * until that Save.
 */
import type { DeviceDisplayOverride } from '@camstack/types'

/** Editable form state — every field a string (empty = "inherit"). */
export interface DisplayForm {
  readonly icon: string
  readonly label: string
  readonly unit: string
  readonly precision: string
  readonly hidden: boolean
}

export const EMPTY_DISPLAY_FORM: DisplayForm = {
  icon: '',
  label: '',
  unit: '',
  precision: '',
  hidden: false,
}

export function displayFormsEqual(a: DisplayForm, b: DisplayForm): boolean {
  return (
    a.icon === b.icon &&
    a.label === b.label &&
    a.unit === b.unit &&
    a.precision === b.precision &&
    a.hidden === b.hidden
  )
}

export function formFromOverride(display: DeviceDisplayOverride | undefined): DisplayForm {
  return {
    icon: display?.icon ?? '',
    label: display?.label ?? '',
    unit: display?.unit ?? '',
    precision: display?.precision !== undefined ? String(display.precision) : '',
    hidden: display?.hidden === true,
  }
}

function parsePrecision(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Build a `DeviceDisplayOverride` from the form, or `null` when fully empty.
 *
 * `perCap` is carried over from the persisted override untouched: this form
 * does not edit it, and a Save that dropped it would silently undo a
 * per-cap refinement written elsewhere.
 */
export function overrideFromForm(
  form: DisplayForm,
  persisted: DeviceDisplayOverride | undefined,
): DeviceDisplayOverride | null {
  const precision = parsePrecision(form.precision)
  const next: DeviceDisplayOverride = {
    ...(form.icon !== '' ? { icon: form.icon } : {}),
    ...(form.label.trim() !== '' ? { label: form.label.trim() } : {}),
    ...(form.unit !== '' ? { unit: form.unit } : {}),
    ...(precision !== undefined ? { precision } : {}),
    ...(form.hidden ? { hidden: true } : {}),
    ...(persisted?.perCap !== undefined ? { perCap: persisted.perCap } : {}),
  }
  return Object.keys(next).length === 0 ? null : next
}

export interface IdentitySeed {
  readonly name: string
  readonly location: string
  readonly role: string | null
  readonly display: DeviceDisplayOverride | undefined
}

export interface IdentityDraft {
  readonly name: string
  readonly location: string
  readonly role: string | null
  readonly display: DisplayForm
  readonly baseName: string
  readonly baseLocation: string
  readonly baseRole: string | null
  readonly baseDisplay: DisplayForm
  /** The server override at seed time, so a save keeps `perCap`. */
  readonly persistedDisplay: DeviceDisplayOverride | undefined
}

function draftFromSeed(seed: IdentitySeed): IdentityDraft {
  const display = formFromOverride(seed.display)
  return {
    name: seed.name,
    location: seed.location,
    role: seed.role,
    display,
    baseName: seed.name,
    baseLocation: seed.location,
    baseRole: seed.role,
    baseDisplay: display,
    persistedDisplay: seed.display,
  }
}

/** Follow the server while the operator has not diverged; keep a dirty draft. */
export function seedIdentityDraft(prev: IdentityDraft | null, seed: IdentitySeed): IdentityDraft {
  if (prev === null) return draftFromSeed(seed)
  const incoming = formFromOverride(seed.display)
  const serverMatchesDraft =
    prev.name === seed.name &&
    prev.location === seed.location &&
    prev.role === seed.role &&
    displayFormsEqual(prev.display, incoming)
  if (!identityDirty(prev) || serverMatchesDraft) return draftFromSeed(seed)
  return prev
}

export function identityDirty(draft: IdentityDraft | null): boolean {
  if (draft === null) return false
  return (
    draft.name !== draft.baseName ||
    draft.location !== draft.baseLocation ||
    draft.role !== draft.baseRole ||
    !displayFormsEqual(draft.display, draft.baseDisplay)
  )
}

/** A cleared name cannot be saved. `null` means the draft may be written. */
export function identitySaveRefusal(draft: IdentityDraft): 'name' | null {
  if (draft.name.trim().length === 0) return 'name'
  return null
}

/** The writes one Save must perform. Absent keys are left untouched. */
export interface IdentityWrites {
  readonly name?: string
  readonly location?: string | null
  readonly role?: string | null
  readonly display?: DeviceDisplayOverride | null
}

export function identityWrites(draft: IdentityDraft): IdentityWrites {
  const name = draft.name.trim()
  const location = draft.location.trim()
  return {
    ...(name !== draft.baseName ? { name } : {}),
    ...(location !== draft.baseLocation ? { location: location === '' ? null : location } : {}),
    ...(draft.role !== draft.baseRole ? { role: draft.role } : {}),
    ...(!displayFormsEqual(draft.display, draft.baseDisplay)
      ? { display: overrideFromForm(draft.display, draft.persistedDisplay) }
      : {}),
  }
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
