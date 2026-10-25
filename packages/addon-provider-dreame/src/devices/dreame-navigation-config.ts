import {
  type NavigationActionEntry,
  type NavigationFeatures,
  NAVIGATION_ACTION_CATALOG,
} from '@camstack/types'

/**
 * DATA-DRIVEN feature flags for the Dreame navigation surface. Keeping these as
 * data (rather than branches in the device class) is what makes enabling /
 * disabling a control later a CONFIG change, not a code change — a future step
 * merges per-device / per-addon overrides on top of these defaults before the
 * cap reports them.
 *
 * `goToPoint` ships OFF: the send-to-map-coordinate path needs map-coordinate
 * plumbing (resolving a tap on the live map to robot coordinates) that is not
 * wired yet. Every other primitive defaults ON.
 */
export const DREAME_NAVIGATION_DEFAULT_FEATURES: NavigationFeatures = {
  move: true,
  stop: true,
  goToPoint: false,
  runAction: true,
  playSound: true,
  light: true,
  lightMode: true,
}

/**
 * Dictionary-entry ids disabled by default for Dreame (data-driven per-entry
 * flags). Empty today — every catalog action / sound is enabled. A future
 * config override drops ids in here (or removes them) without touching code.
 */
export const DREAME_NAVIGATION_DISABLED_ENTRY_IDS: ReadonlySet<string> = new Set<string>()

/**
 * The action dictionary as THIS provider reports it: the shared catalog with the
 * per-entry `enabled` flag resolved from {@link DREAME_NAVIGATION_DISABLED_ENTRY_IDS}.
 * Pure — the device method just returns this (a later step layers device config
 * on top).
 */
export function dreameNavigationCatalog(
  disabledEntryIds: ReadonlySet<string> = DREAME_NAVIGATION_DISABLED_ENTRY_IDS,
): NavigationActionEntry[] {
  return NAVIGATION_ACTION_CATALOG.map((entry) => ({
    ...entry,
    enabled: entry.enabled && !disabledEntryIds.has(entry.id),
  }))
}

/**
 * Per-device overrides, as the device config carries them (every field
 * optional — absent means "the default"). A flag set here wins over
 * {@link DREAME_NAVIGATION_DEFAULT_FEATURES}; an entry id listed in
 * `disabledEntryIds` is switched off on top of the addon default set.
 */
export interface DreameNavigationOverrides {
  readonly features?: Partial<NavigationFeatures>
  readonly disabledEntryIds?: readonly string[]
}

/** The feature flags in force for ONE device: defaults, then its overrides. */
export function resolveNavigationFeatures(
  overrides: DreameNavigationOverrides | undefined,
): NavigationFeatures {
  return { ...DREAME_NAVIGATION_DEFAULT_FEATURES, ...overrides?.features }
}

/** The disabled entry ids in force for ONE device: the addon set plus its own. */
export function resolveDisabledEntryIds(
  overrides: DreameNavigationOverrides | undefined,
): ReadonlySet<string> {
  return new Set([...DREAME_NAVIGATION_DISABLED_ENTRY_IDS, ...(overrides?.disabledEntryIds ?? [])])
}
