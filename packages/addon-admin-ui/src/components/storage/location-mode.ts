/**
 * The FOUR states a storage location can be in, and the one place the UI
 * derives them.
 *
 * A location used to carry two independent booleans — `enabled` (the write
 * switch, D383) and `config.readOnly` (drain) — and an operator had to hold
 * their product in their head. They are one enum now:
 *
 * | mode       | writes | reads | eviction                                  |
 * | ---------- | ------ | ----- | ----------------------------------------- |
 * | `active`   | yes    | yes   | normal, on disk pressure                  |
 * | `readonly` | no     | yes   | never — a frozen archive                  |
 * | `drain`    | no     | yes   | paced, oldest-first, until the disk is empty |
 * | `disabled` | no     | NO    | never — the footage here leaves the timeline |
 *
 * `disabled` is the only state that takes something AWAY from the operator's
 * timeline, and every surface that offers it says so in words.
 */
import {
  resolveLocationMode as resolveLocationModeFromTypes,
  type StorageLocation,
  type StorageLocationMode,
  type StorageLocationStateSource,
} from '@camstack/types'
import i18n from '../../i18n/index'

/** The mode union, owned by `@camstack/types` (D385). Re-exported so the UI
 *  has one name for it and no second definition to drift. */
export type LocationMode = StorageLocationMode

/** A row as this module reads it: the new field, plus the legacy pair. */
export type LocationModeFacts = StorageLocationStateSource

/**
 * Fold a row into its mode.
 *
 * Delegated to the owning module in `@camstack/types` so the UI can never fold
 * a row differently from the server. Both legacy flags — `config.readOnly` and
 * `enabled: false` — mean `readonly`: neither ever deleted on its own, and
 * folding either to `drain` would start deleting footage on upgrade. Nothing
 * legacy folds to `disabled` either, because no old row ever hid its footage
 * from the timeline.
 */
export function resolveLocationMode(location: LocationModeFacts): LocationMode {
  return resolveLocationModeFromTypes(location)
}

/** Modes that accept new writes. Only one does. */
export function modeAcceptsWrites(mode: LocationMode): boolean {
  return mode === 'active'
}

/** Modes whose data is still readable — everything but `disabled`. */
export function modeServesReads(mode: LocationMode): boolean {
  return mode !== 'disabled'
}

export interface LocationModeChoice {
  readonly mode: LocationMode
  readonly label: string
  /** The consequence, in the control itself — never a tooltip only. */
  readonly consequence: string
  /** `disabled` hides footage; it is the only choice worth a confirmation. */
  readonly requiresConfirmation: boolean
}

export const LOCATION_MODE_CHOICES: readonly LocationModeChoice[] = [
  {
    mode: 'active',
    get label() {
      return i18n.t('helpers.locationMode.activeLabel')
    },
    get consequence() {
      return i18n.t('helpers.locationMode.activeConsequence')
    },
    requiresConfirmation: false,
  },
  {
    mode: 'readonly',
    get label() {
      return i18n.t('helpers.locationMode.readonlyLabel')
    },
    get consequence() {
      return i18n.t('helpers.locationMode.readonlyConsequence')
    },
    requiresConfirmation: false,
  },
  {
    mode: 'drain',
    get label() {
      return i18n.t('helpers.locationMode.drainLabel')
    },
    get consequence() {
      return i18n.t('helpers.locationMode.drainConsequence')
    },
    requiresConfirmation: false,
  },
  {
    mode: 'disabled',
    get label() {
      return i18n.t('helpers.locationMode.disabledLabel')
    },
    get consequence() {
      return i18n.t('helpers.locationMode.disabledConsequence')
    },
    requiresConfirmation: true,
  },
]

export function locationModeChoice(mode: LocationMode): LocationModeChoice {
  const found = LOCATION_MODE_CHOICES.find((c) => c.mode === mode)
  // Every member of the union has an entry; the fallback keeps the return
  // type honest without a cast.
  return found ?? LOCATION_MODE_CHOICES[0]!
}

/** True when picking `mode` should ask the operator first. */
export function modeRequiresConfirmation(mode: LocationMode): boolean {
  return locationModeChoice(mode).requiresConfirmation
}

export interface ModeChangeVerdict {
  readonly blocked: boolean
  /** Why, in the words the control shows. Empty when nothing is blocked. */
  readonly reason: string
}

const LAST_WRITABLE_REASON =
  'Blocked: this is the last location of its type still accepting writes — new data would have nowhere to go.'

/**
 * May this location move to `next`?
 *
 * The one guard that survives the collapse of the two switches: the LAST
 * location of a type that still accepts writes cannot leave `active`. The
 * control still renders — the operator has to be able to SEE why the choice
 * is refused — it just does not fire.
 */
export function modeChangeBlocked(
  location: LocationModeFacts & Pick<StorageLocation, 'id'>,
  siblings: readonly (LocationModeFacts & Pick<StorageLocation, 'id'>)[],
  next: LocationMode,
): ModeChangeVerdict {
  if (modeAcceptsWrites(next)) return { blocked: false, reason: '' }
  if (!modeAcceptsWrites(resolveLocationMode(location))) return { blocked: false, reason: '' }
  const otherWritable = siblings.some(
    (s) => s.id !== location.id && modeAcceptsWrites(resolveLocationMode(s)),
  )
  return otherWritable
    ? { blocked: false, reason: '' }
    : { blocked: true, reason: LAST_WRITABLE_REASON }
}

/** Blocked reason per mode; the empty string means the choice is allowed. */
export type LocationModeReasons = Readonly<Record<LocationMode, string>>

/**
 * Every mode's verdict for one location, so a selector can render all four
 * choices — a refused choice is still SHOWN, with its reason, rather than
 * missing.
 */
export function modeBlockedReasons(
  location: LocationModeFacts & Pick<StorageLocation, 'id'>,
  siblings: readonly (LocationModeFacts & Pick<StorageLocation, 'id'>)[],
): LocationModeReasons {
  return {
    active: modeChangeBlocked(location, siblings, 'active').reason,
    readonly: modeChangeBlocked(location, siblings, 'readonly').reason,
    drain: modeChangeBlocked(location, siblings, 'drain').reason,
    disabled: modeChangeBlocked(location, siblings, 'disabled').reason,
  }
}
