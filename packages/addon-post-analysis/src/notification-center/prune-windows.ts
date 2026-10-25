/**
 * The operator-configurable prune windows, in days. One module, because the
 * question "how long does this system keep X" had five answers hardcoded in
 * five files and no way to ask any of them.
 *
 * ## What changed, and what it costs
 *
 * The artefact shelf used to carry THREE bounds — 14 days, 2 000 rows, 2 GiB —
 * and whichever bit first won. Exposing only the days would have handed the
 * operator a number that does not decide: raise it to 60 and the shelf still
 * cuts at 2 000 rows, with nothing saying why. On the operator's instruction
 * the shelf is now days-ONLY, so the number means what it says.
 *
 * The cost is named rather than hidden: `artifacts` is NOT a class the storage
 * evictor sweeps (it is absent from `STORAGE_CLASS_SUBTREES`), so those bounds
 * were the only thing standing between that shelf and the disk. Measured on the
 * live hub 2026-09-13: 901 retained files, ~710 MB, the busiest camera at
 * 820 files / 580 MB — so at the 14-day default the age bound is what bites
 * today and the other two never fired. At 60 days that one camera alone would
 * hold roughly 2.5 GB, and nothing would stop it.
 *
 * ## Zero means forever
 *
 * `0` is the one way to turn a window off, and it resolves to `null`, never to
 * a cutoff of `now`. A zero that became `now - 0` would delete the entire shelf
 * on the next pass — the failure mode is total, silent and unrecoverable, so it
 * gets a test rather than a convention.
 *
 * A value that is negative, NaN or absent falls back to the shipped default:
 * an unreadable window must not become a window nobody chose.
 */

const DAY_MS = 24 * 3600_000

/**
 * The shipped windows. Each one is the value that was hardcoded before this
 * module existed, except the mosaic — see {@link PRUNE_SETTING_KEYS}.
 */
export const PRUNE_WINDOW_DEFAULT_DAYS = {
  /** Terminal outbox rows. Was `OUTBOX_RETENTION_MS`, 7 days. */
  outboxDays: 7,
  /** A rendered timelapse export. Was `TIMELAPSE_EXPORT_LIFE_MS`, 7 days. */
  timelapseExportDays: 7,
  /** The retained artefact shelf. Was `DEFAULT_KEPT_MAX_AGE_MS`, 14 days. */
  artifactShelfDays: 14,
  /**
   * A rule's digest mosaics. This one REPLACES a bound of a different kind:
   * D480 bounded them by COUNT (200 per rule) on the argument that a
   * writer-imposed limit has no clock. The operator asked for days, so the
   * mechanism changed and not just the number — see D485.
   *
   * The arithmetic, from the live hub: the busiest rule makes ~66 mosaics and
   * ~27 MiB a day. 14 days is ~370 MiB for that rule, against ~80 MiB under
   * the old count bound. A quiet rule (one digest a night) goes the other way:
   * from over six months of history down to 14 days. Both directions are real,
   * which is the honest reason this became a knob instead of a new constant.
   */
  summaryMosaicDays: 14,
} as const

export type PruneSettingKey = keyof typeof PRUNE_WINDOW_DEFAULT_DAYS

/**
 * The declared surface, for `scripts/check-prune-settings-consumed.ts`. A knob
 * that reaches the store but never reaches a sweep decides nothing, and this
 * repo has shipped three of those (D62's per-family windows,
 * `zoneMembershipMinOverlap`, `rescueCentroidFactor`). Enumerating them is what
 * lets a script notice.
 */
export const PRUNE_SETTING_KEYS: readonly PruneSettingKey[] = [
  'outboxDays',
  'timelapseExportDays',
  'artifactShelfDays',
  'summaryMosaicDays',
]

/** What the settings store may hold. Every field optional: absent = default. */
export type PruneSettingsInput = Partial<Record<PruneSettingKey, unknown>>

/**
 * The resolved windows, in milliseconds. `null` means "no cutoff" — every
 * consumer skips its sweep on `null` rather than inventing one.
 */
export interface PruneWindows {
  readonly outboxMs: number | null
  readonly timelapseExportMs: number | null
  readonly artifactShelfMs: number | null
  readonly summaryMosaicMs: number | null
}

/**
 * One configured value → a window. Absent, negative or non-finite falls back to
 * the default; `0` is the deliberate "keep forever" and is the ONLY way to get
 * `null` out of this function.
 */
function windowMs(raw: unknown, defaultDays: number): number | null {
  if (raw === 0) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return defaultDays * DAY_MS
  }
  return raw * DAY_MS
}

export function resolvePruneWindows(settings: PruneSettingsInput): PruneWindows {
  return {
    outboxMs: windowMs(settings.outboxDays, PRUNE_WINDOW_DEFAULT_DAYS.outboxDays),
    timelapseExportMs: windowMs(
      settings.timelapseExportDays,
      PRUNE_WINDOW_DEFAULT_DAYS.timelapseExportDays,
    ),
    artifactShelfMs: windowMs(
      settings.artifactShelfDays,
      PRUNE_WINDOW_DEFAULT_DAYS.artifactShelfDays,
    ),
    summaryMosaicMs: windowMs(
      settings.summaryMosaicDays,
      PRUNE_WINDOW_DEFAULT_DAYS.summaryMosaicDays,
    ),
  }
}
