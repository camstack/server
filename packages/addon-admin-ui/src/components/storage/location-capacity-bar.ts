/**
 * The geometry and the words of a location's capacity bar. PURE — the card
 * only paints what this returns.
 *
 * One derivation, not two: fill and severity come from
 * `components/recordings/storage-fill.ts` (`resolveVolumeFill`, the
 * warn/critical fractions), which is the module the Recordings page already
 * reads. A second severity scale on the Storage page would be a second answer
 * to "is this disk full?".
 *
 * ## Four DISJOINT bands, left to right, summing to the volume
 *
 * | band | what it is |
 * | --- | --- |
 * | `reserve` | the protected space, taken OUT OF FREE — not out of what is stored |
 * | `owned`   | what CamStack itself holds here, when a figure measured it |
 * | `used`    | everything else occupying the disk: used MINUS our share |
 * | `free`    | what is left after the reserve is set aside |
 *
 * They used to overlap: `used` was every tenant INCLUDING us, so a shared disk
 * printed "1.6 TB used" and "1.5 TB CamStack" for the same bytes, and the
 * reserve was drawn over free space it had already counted. Four bands in a row
 * that overlap make the bar lie about proportions, so they are cut apart here:
 * `used` is now the non-CamStack remainder and is LABELLED as such, and the
 * percentages sum to 100 within rounding.
 *
 * With no measured share the bar falls back to three bands — reserve, used
 * (everything occupied), free — and the legend loses that entry. An unmeasured
 * share is never drawn as a zero-width band standing in for "unknown" (D315).
 *
 * The system-managed cap is a MARK, not a band, and only where one is in force
 * (a legacy stored `maxUsedGb`, or a draining location whose descending cap IS
 * the progress). It sits at the far edge of where our own band may reach.
 *
 * A volume nothing measured has NO bar. `capacity unknown` is the render; an
 * empty bar reads as plenty of room and this repo has shipped that mistake
 * once already — most recently as two `backups` rows, a local disk and an SMB
 * share, printing byte-identical bars because the probe `statfs`'d a local
 * path for both (2026-09-13). What CamStack HOLDS there is a separate
 * measurement and survives: an unknown denominator does not erase a known
 * numerator.
 */
import { formatBytes } from '../../lib/format-size'
import {
  fillSeverity,
  resolveVolumeFill,
  type VolumeFillSeverity,
} from '../recordings/storage-fill'
import type { SystemCap } from './location-protection'
import i18n from '../../i18n/index'

/** The two figures `StorageLocation.capacity` carries, or nothing. */
export interface LocationCapacityFacts {
  readonly totalBytes: number | null
  readonly availableBytes: number | null
}

/**
 * Widths, in percent of the bar, ready for a CSS `width`. The four band
 * percentages are DISJOINT and sum to 100 within rounding.
 */
export interface CapacityBarSegments {
  /** The protected reserve, taken out of free. 0 when unprotected. */
  readonly reservePercent: number
  /**
   * CamStack's OWN share. `null` when nothing measured it — never 0, which
   * would state that we occupy nothing (D315).
   */
  readonly ownedPercent: number | null
  /** Everything else on the disk: occupied minus our share. */
  readonly usedPercent: number
  /** What is left once the reserve is set aside. */
  readonly freePercent: number
  /** Where the system-managed cap sits, as a mark. `null` when none is in force. */
  readonly capPercent: number | null
}

export interface CapacityBarLabels {
  readonly total: string
  /** Free as `statfs` reports it — the reserve included. */
  readonly freeTotal: string
  readonly freeTotalPercent: string
  /** The non-CamStack remainder band. */
  readonly used: string
  readonly usedPercent: string
  /** The free band: what is left after the reserve. */
  readonly free: string
  readonly freePercent: string
  /** `null` when the location protects nothing. */
  readonly reserve: string | null
  /** `null` when CamStack's share of this volume is not measurable. */
  readonly owned: string | null
  /** `null` when no cap is in force. */
  readonly cap: string | null
}

/**
 * Which part of the bar a legend entry names. It is the SEGMENT's id, not a
 * colour: the component looks the colour up in the one table it paints the
 * segment with, so a swatch cannot drift from the band it stands for.
 */
export type CapacitySegmentId = 'reserve' | 'owned' | 'used' | 'free' | 'cap'

/** One line of the legend under the bar. */
export interface CapacityLegendEntry {
  readonly segment: CapacitySegmentId
  readonly label: string
  readonly value: string
  /** This entry is the problem on this disk — the component paints it as such. */
  readonly alarming: boolean
}

export interface KnownCapacityBar {
  readonly kind: 'known'
  readonly severity: VolumeFillSeverity
  readonly segments: CapacityBarSegments
  readonly labels: CapacityBarLabels
  /**
   * The legend, built from the SAME pass that produced the segments, in the
   * SAME left-to-right order: an entry exists exactly when its band does, so
   * the bar can never show a band nothing names, nor name a band it does not
   * draw.
   */
  readonly legend: readonly CapacityLegendEntry[]
  /** The reserve can no longer be held: the disk owes more than it has free. */
  readonly reserveExceedsFree: boolean
  /** A cap already below what we hold — eviction is behind, not idle. */
  readonly capBelowOwned: boolean
  /** One line, the whole state, for a title attribute and for tests. */
  readonly summary: string
}

export interface UnknownCapacityBar {
  readonly kind: 'unknown'
  readonly summary: string
  /**
   * What CamStack holds here, when something measured it — `null` when nothing
   * did. Unknown capacity is a missing DENOMINATOR; it says nothing about the
   * numerator, and a share the storage providers reported is a fact this row
   * still has. A remote share (SMB, S3) is the normal case: no local `statfs`
   * describes it, yet the provider writing to it knows exactly what it put
   * there.
   */
  readonly owned: string | null
}

export type CapacityBar = KnownCapacityBar | UnknownCapacityBar

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function roundPercent(fraction: number): number {
  return Math.round(clampFraction(fraction) * 1000) / 10
}

function formatPercent(fraction: number): string {
  return `${String(Math.round(clampFraction(fraction) * 100))}%`
}

/** What the bar shows BESIDES the volume's own fill. */
export interface CapacityBarExtras {
  /**
   * Bytes CamStack itself holds on this volume (`location-owned-usage.ts`).
   * `null`/absent means nobody measured it and NO band is drawn.
   */
  readonly ownedBytes?: number | null
  /** The system-managed cap in force, from `resolveSystemCap`. */
  readonly cap?: SystemCap | null
}

/**
 * Build the bar. `reserveBytes` is the location's protection setting resolved
 * to bytes (see `location-protection.ts`); `null` or a non-positive number
 * means the location protects nothing and no band is drawn.
 *
 * `extras.ownedBytes` is CamStack's share, carried the way `storage-fill.ts`
 * already carries `recordingsFraction` — the same derivation, not a parallel
 * one. `extras.cap` is marked only when a cap is actually in force.
 */
export function resolveCapacityBar(
  facts: LocationCapacityFacts,
  reserveBytes: number | null,
  extras: CapacityBarExtras = {},
): CapacityBar {
  const { totalBytes, availableBytes } = facts
  if (totalBytes === null || totalBytes <= 0 || availableBytes === null) {
    const measuredShare =
      extras.ownedBytes === undefined ||
      extras.ownedBytes === null ||
      !Number.isFinite(extras.ownedBytes) ||
      extras.ownedBytes < 0
        ? null
        : formatBytes(extras.ownedBytes)
    return {
      kind: 'unknown',
      owned: measuredShare,
      summary:
        measuredShare === null
          ? i18n.t('helpers.locationCapacityBar.unknownSummary')
          : i18n.t('helpers.locationCapacityBar.unknownSummaryOwned', { size: measuredShare }),
    }
  }
  // A filesystem reporting more free than total is a bad reading, not a
  // negative disk: the fill floors at 0 and the free bytes cap at the total.
  const freeBytes = Math.min(Math.max(availableBytes, 0), totalBytes)
  const occupiedBytes = totalBytes - freeBytes

  // The reserve comes out of FREE, and never takes more than there is: a
  // reserve larger than the free space is a state to report, not a band that
  // eats into somebody else's bytes.
  const reserveWanted = reserveBytes === null || reserveBytes <= 0 ? 0 : reserveBytes
  const reserveBand = Math.min(reserveWanted, freeBytes)
  const reserveExceedsFree = reserveWanted > freeBytes
  const freeBand = freeBytes - reserveBand

  // CamStack's share rides the SAME derivation as the volume fill: `usedBytes`
  // on a `RecordingLocationUsage` row is what `resolveVolumeFill` already calls
  // `recordingsFraction`. Clamped to what is actually occupied, so a stale
  // measurement can never carve a band out of somebody else's bytes.
  const ownedInput = extras.ownedBytes
  const ownedBand =
    ownedInput === undefined ||
    ownedInput === null ||
    !Number.isFinite(ownedInput) ||
    ownedInput < 0
      ? null
      : Math.min(ownedInput, occupiedBytes)
  const usedBand = occupiedBytes - (ownedBand ?? 0)

  const fill = resolveVolumeFill({
    usedBytes: ownedBand ?? occupiedBytes,
    availableBytes: freeBytes,
    totalBytes,
  })
  const occupiedFraction = fill === null ? clampFraction(occupiedBytes / totalBytes) : fill.fraction
  const severity = fill === null ? fillSeverity(occupiedFraction) : fill.severity
  const ownedFraction =
    ownedBand === null
      ? null
      : fill === null
        ? clampFraction(ownedBand / totalBytes)
        : fill.recordingsFraction

  const cap = extras.cap ?? null
  // The cap limits OUR share, so it marks the far edge our band may reach —
  // measured from where that band starts, just past the reserve.
  const capFraction = cap === null ? null : clampFraction((reserveBand + cap.bytes) / totalBytes)
  const capBelowOwned = cap !== null && ownedBand !== null && ownedBand > cap.bytes

  const labels: CapacityBarLabels = {
    total: formatBytes(totalBytes),
    freeTotal: formatBytes(freeBytes),
    freeTotalPercent: formatPercent(freeBytes / totalBytes),
    used: formatBytes(usedBand),
    usedPercent: formatPercent(usedBand / totalBytes),
    free: formatBytes(freeBand),
    freePercent: formatPercent(freeBand / totalBytes),
    reserve:
      reserveWanted === 0
        ? null
        : i18n.t('helpers.locationCapacityBar.reserveKept', { size: formatBytes(reserveWanted) }),
    owned:
      ownedBand === null || ownedFraction === null
        ? null
        : i18n.t('helpers.locationCapacityBar.ownedOfRecordings', {
            size: formatBytes(ownedBand),
            percent: formatPercent(ownedFraction),
          }),
    cap:
      cap === null
        ? null
        : cap.reason === 'drain'
          ? i18n.t('helpers.locationCapacityBar.capDrain', { size: formatBytes(cap.bytes) })
          : i18n.t('helpers.locationCapacityBar.capCap', { size: formatBytes(cap.bytes) }),
  }

  const summary = [
    i18n.t('helpers.locationCapacityBar.summaryFree', {
      free: labels.freeTotal,
      total: labels.total,
      percent: labels.freeTotalPercent,
    }),
    labels.owned === null
      ? null
      : i18n.t('helpers.locationCapacityBar.summaryOwned', { owned: labels.owned }),
    labels.reserve === null
      ? null
      : reserveExceedsFree
        ? i18n.t('helpers.locationCapacityBar.summaryReserveShort', { reserve: labels.reserve })
        : labels.reserve,
    labels.cap === null
      ? null
      : capBelowOwned
        ? i18n.t('helpers.locationCapacityBar.summaryCapBelow', { cap: labels.cap })
        : labels.cap,
  ]
    .filter((part) => part !== null)
    .join(' · ')

  // One pass, one source, ONE ORDER: entries are pushed in the order the bands
  // are drawn. The unmeasured share stays absent HERE too — a legend line
  // reading "CamStack 0 B" is the same lie as a zero-width band.
  // `reserve` and `owned` are the CONDITIONAL bands and each is paired with its
  // entry exactly. `used` and `free` are the volume's two halves and are always
  // both — a measured zero there is a fact, not an absence.
  const legend: CapacityLegendEntry[] = []
  if (reserveBand > 0) {
    legend.push({
      segment: 'reserve',
      label: i18n.t('helpers.locationCapacityBar.legendKeptFree'),
      value: formatBytes(reserveWanted),
      alarming: reserveExceedsFree,
    })
  }
  if (labels.owned !== null) {
    legend.push({
      segment: 'owned',
      label: i18n.t('helpers.locationCapacityBar.legendCamstack'),
      value: labels.owned,
      alarming: false,
    })
  }
  legend.push({
    // With a share measured this band is what ELSE is on the disk; without one
    // it is everything that is on it. The label says which.
    segment: 'used',
    label:
      ownedBand === null
        ? i18n.t('helpers.locationCapacityBar.legendUsed')
        : i18n.t('helpers.locationCapacityBar.legendOtherData'),
    value: `${labels.used} (${labels.usedPercent})`,
    alarming: severity === 'critical',
  })
  legend.push({
    segment: 'free',
    label: i18n.t('helpers.locationCapacityBar.legendFree'),
    value: `${labels.free} (${labels.freePercent})`,
    // A reserve that cannot be held IS the free space's problem: on a disk with
    // nothing left, the reserve band is gone and this is where it shows.
    alarming: reserveExceedsFree,
  })
  if (cap !== null) {
    legend.push({
      segment: 'cap',
      label:
        cap.reason === 'drain'
          ? i18n.t('helpers.locationCapacityBar.legendDrainTarget')
          : i18n.t('helpers.locationCapacityBar.legendCap'),
      value: i18n.t('helpers.locationCapacityBar.legendCapValue', { size: formatBytes(cap.bytes) }),
      alarming: capBelowOwned,
    })
  }

  return {
    kind: 'known',
    severity,
    legend,
    segments: {
      reservePercent: roundPercent(reserveBand / totalBytes),
      ownedPercent: ownedBand === null ? null : roundPercent(ownedBand / totalBytes),
      usedPercent: roundPercent(usedBand / totalBytes),
      freePercent: roundPercent(freeBand / totalBytes),
      capPercent: capFraction === null ? null : roundPercent(capFraction),
    },
    labels,
    reserveExceedsFree,
    capBelowOwned,
    summary,
  }
}
