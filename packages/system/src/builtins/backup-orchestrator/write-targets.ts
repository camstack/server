/**
 * Which `backups` locations tonight's archive may land on.
 *
 * ## Why this is its own module
 *
 * The orchestrator had **two** enabled switches for one function: the
 * operator-visible `StorageLocation.enabled` on the storage screen, and
 * `backup_destination_policies.enabled`, seeded `true` for every newly-seen
 * location. Only the second one was consulted, so a location the storage
 * screen showed as disabled still received the archive — the exact shape D62
 * exists to forbid ("a second switch that disagrees with the first is worse
 * than no switch").
 *
 * The location flag is now the OUTER gate for every path, and the policy flag
 * keeps its narrower meaning: *this destination takes part in the unattended
 * fan-out*. An explicit request (an operator pressing Back up now with a
 * destination selected, or a schedule naming `locationIds`) still overrides
 * the policy flag — it never overrides the location flag, because that one is
 * the operator saying "do not write here" about the disk itself.
 *
 * Kept pure and separate so the decision can be read in one screen and the
 * addon is left with fetch → decide → log → upload.
 */

/** One `backups` location, reduced to the two flags that decide a write. */
export interface BackupTargetCandidate {
  readonly id: string
  /**
   * `StorageLocation.enabled`. ABSENT MEANS ACTIVE — the caller maps
   * `enabled !== false`, so a legacy location persisted before the flag
   * existed stays a destination.
   */
  readonly locationEnabled: boolean
  /** `backup_destination_policies.enabled` — the unattended-fan-out opt-in. */
  readonly policyEnabled: boolean
}

export interface BackupTargetSelection {
  /** Destinations the archive may be written to. */
  readonly targets: readonly BackupTargetCandidate[]
  /**
   * Ids dropped because the OPERATOR disabled the storage location. Returned
   * rather than silently filtered: a fan-out that drops a destination must say
   * so, and the caller decides between "log and continue" and "refuse".
   */
  readonly skippedDisabled: readonly string[]
}

export interface BackupTargetSelectionInput {
  readonly candidates: readonly BackupTargetCandidate[]
  /** Explicitly named destinations (cap input, or a schedule's `locationIds`). */
  readonly requested?: readonly string[]
}

/**
 * Pick the destinations an archive may be fanned out to.
 *
 * An explicit `requested` list selects from the candidates by id and bypasses
 * the policy flag (that is today's behaviour and it is right: naming a
 * destination IS the opt-in). A requested id that is not a `backups` location
 * at all is simply absent from the candidates and drops out here, exactly as
 * before.
 *
 * The location flag is applied LAST and to both paths, so there is one place
 * where "disabled" is honoured rather than one per caller.
 */
export function selectBackupTargets(input: BackupTargetSelectionInput): BackupTargetSelection {
  const requested = input.requested
  const pool =
    requested && requested.length > 0
      ? input.candidates.filter((c) => requested.includes(c.id))
      : input.candidates.filter((c) => c.policyEnabled)
  return {
    targets: pool.filter((c) => c.locationEnabled),
    skippedDisabled: pool.filter((c) => !c.locationEnabled).map((c) => c.id),
  }
}
