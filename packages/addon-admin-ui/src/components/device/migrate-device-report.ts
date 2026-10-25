/**
 * Turning a `deviceManager.migrateDevice` answer into something an operator can
 * act on — WITHOUT inventing a success flag the cap deliberately refused to
 * return.
 *
 * The composition this reads is documented in
 * `packages/system/src/builtins/device-manager/migrate-device.ts`. Three facts
 * from it drive everything here:
 *
 *  - **`sourceStillLive` is the verdict.** Empty is the only value that means
 *    "the replaced hardware is quiet". Non-empty is neither an error nor a
 *    success: the migration happened, and named functions are still running on
 *    hardware the hub could not reach. The operator has to be told, because the
 *    remaining fix is physical — pull the power, pull the cable.
 *  - **`unreachable` and `not-offered` are different answers and must never be
 *    merged.** `unreachable` is "could not ask"; `not-offered` is "this camera
 *    never had that switch". Folding the second into the first would report a
 *    camera as still recording over a function it never possessed.
 *  - **The same numeric id appears on both sides of the swap.** `applyAll` runs
 *    down-on-source, down-on-target, swap, up-on-source — so rows tagged with
 *    `sourceId` in the DOWN phase describe the OLD hardware and rows tagged
 *    with `sourceId` in the UP phase describe the NEW hardware answering on the
 *    inherited number. Only the first row per switch belongs to the old camera,
 *    which is why {@link buildMigrationReport} dedupes on first occurrence
 *    rather than filtering the whole array on `deviceId`.
 *
 * Pure on purpose: the rendering rule that must not regress is a data rule, and
 * a data rule is cheaper to pin than a DOM.
 */
import {
  CAMERA_SWITCH_CATALOG,
  type CameraSwitchId,
  type MigrateDeviceResult,
  type MigrateSwitchReport,
} from '@camstack/types'

/**
 * The one question the banner answers.
 *
 * There is no `'success'`. A migration that left functions running on the old
 * camera did everything it was asked and is still not a quiet outcome, and a
 * migration is never reported as having failed here — a failed swap throws and
 * never produces a result at all.
 */
export type MigrationVerdict = 'quiet' | 'still-live'

/** One named function, for a list the operator reads. */
export interface MigrationSwitchLine {
  readonly switchId: CameraSwitchId
  /** Operator-facing name from the catalog — never the raw id. */
  readonly label: string
  /** The hub's refusal, verbatim. `null` when there was nothing to quote. */
  readonly detail: string | null
}

export interface MigrationReport {
  /** The number the NEW hardware now answers on — the one all the work is
   *  filed under. */
  readonly inheritedId: number
  /** The number the replaced hardware was handed in exchange. */
  readonly retiredId: number
  readonly swapped: boolean
  readonly verdict: MigrationVerdict
  /**
   * Functions the hub could NOT switch off on the replaced camera. Sourced
   * ONLY from `sourceStillLive` — never recomputed from the switch rows, so
   * this list can never disagree with the cap's own verdict.
   */
  readonly stillLive: readonly MigrationSwitchLine[]
  /**
   * Functions the replaced camera never offered. Reported separately and
   * explicitly so "there was nothing to switch off" is not read as "it is
   * still running".
   */
  readonly neverOffered: readonly MigrationSwitchLine[]
}

function lineFor(switchId: CameraSwitchId, detail: string | undefined): MigrationSwitchLine {
  return {
    switchId,
    label: CAMERA_SWITCH_CATALOG[switchId].label,
    detail: detail === undefined || detail.length === 0 ? null : detail,
  }
}

/**
 * The DOWN-phase rows for the replaced camera, one per switch.
 *
 * First occurrence wins: the UP phase writes the same `sourceId` after the
 * swap, and those rows describe the NEW hardware. Anything later is discarded.
 */
function downPhaseSourceRows(
  result: MigrateDeviceResult,
): ReadonlyMap<CameraSwitchId, MigrateSwitchReport> {
  const rows = new Map<CameraSwitchId, MigrateSwitchReport>()
  for (const row of result.switches) {
    if (row.deviceId !== result.sourceId) continue
    if (rows.has(row.switchId)) continue
    rows.set(row.switchId, row)
  }
  return rows
}

/**
 * Build what the card renders. Never returns a boolean verdict, and never
 * counts a `not-offered` switch as still live.
 */
export function buildMigrationReport(result: MigrateDeviceResult): MigrationReport {
  const rows = downPhaseSourceRows(result)
  const stillLiveIds = new Set<CameraSwitchId>(result.sourceStillLive)

  const stillLive = result.sourceStillLive.map((switchId) =>
    lineFor(switchId, rows.get(switchId)?.detail),
  )

  // `not-offered` is a distinct answer, so it gets a distinct list. The
  // `stillLiveIds` guard is not decoration: if the two ever overlapped, the
  // safe reading is "still live", and a switch must appear in exactly one list.
  const neverOffered = [...rows.values()]
    .filter((row) => row.outcome === 'not-offered' && !stillLiveIds.has(row.switchId))
    .map((row) => lineFor(row.switchId, row.detail))

  return {
    inheritedId: result.sourceId,
    retiredId: result.targetId,
    swapped: result.swapped,
    verdict: stillLive.length === 0 ? 'quiet' : 'still-live',
    stillLive,
    neverOffered,
  }
}
