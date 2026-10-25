/**
 * The capacity bar on a location row. Paints {@link resolveCapacityBar} and
 * derives nothing of its own.
 *
 * The numbers are a LEGEND under the bar, one entry per band, IN THE SAME
 * ORDER as the bands, each carrying the colour of the band it names — the run-on sentence they used to be
 * ("194 GB free (10%) of 1.8 TB · CamStack 1.5 TB of recordings (84%) · …")
 * wrapped onto three lines and squeezed the bar into a corner. `SEGMENT_CLASS`
 * is the ONE table: the band and its swatch read the same entry, so a colour
 * cannot drift from the thing it stands for.
 */
import type { StorageLocation } from '@camstack/types'
import type { VolumeFillSeverity } from '../recordings/storage-fill'
import {
  type CapacityBar,
  type CapacitySegmentId,
  resolveCapacityBar,
} from './location-capacity-bar'
import { resolveLocationMode } from './location-mode'
import {
  protectionReserveBytes,
  readProtectionPolicy,
  resolveSystemCap,
} from './location-protection'
import { useTranslation } from 'react-i18next'

/** The same three tokens the Recordings page paints its volumes with. */
const FILL_BAR_CLASS: Readonly<Record<VolumeFillSeverity, string>> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  critical: 'bg-danger',
}

/** Segment → the colour it is painted in, for the band AND its swatch. */
const SEGMENT_CLASS: Readonly<Record<Exclude<CapacitySegmentId, 'used'>, string>> = {
  reserve: 'bg-danger/40',
  owned: 'bg-foreground/50',
  free: 'bg-border',
  cap: 'bg-foreground',
}

function swatchClass(segment: CapacitySegmentId, severity: VolumeFillSeverity): string {
  return segment === 'used' ? FILL_BAR_CLASS[severity] : SEGMENT_CLASS[segment]
}

export interface LocationCapacityBarProps {
  readonly location: Pick<StorageLocation, 'capacity' | 'config' | 'enabled'>
  /**
   * Bytes CamStack holds on this volume. `null`/absent means nobody measured
   * it and the inner segment — and its legend entry — are OMITTED.
   */
  readonly ownedBytes?: number | null
}

export function LocationCapacityBar({ location, ownedBytes }: LocationCapacityBarProps) {
  const { t } = useTranslation()
  const capacity = location.capacity ?? null
  const policy = readProtectionPolicy(location.config)
  const reserveBytes = protectionReserveBytes(policy, capacity?.totalBytes ?? null)
  const bar: CapacityBar = resolveCapacityBar(
    {
      totalBytes: capacity?.totalBytes ?? null,
      availableBytes: capacity?.availableBytes ?? null,
    },
    reserveBytes,
    {
      ownedBytes: ownedBytes ?? null,
      cap: resolveSystemCap(location.config, resolveLocationMode(location)),
    },
  )
  if (bar.kind === 'unknown') {
    return (
      <div className="text-[10px] text-foreground-subtle italic" title={bar.summary}>
        {bar.owned === null
          ? t('storage.locationCapacityBar.capacityUnknown', 'Capacity unknown')
          : t(
              'storage.locationCapacityBar.capacityUnknownCamstackHolds',
              'Capacity unknown · CamStack holds {{owned}}',
              { owned: bar.owned },
            )}
      </div>
    )
  }
  return (
    <div className="mt-1 space-y-1" title={bar.summary}>
      {/* Four DISJOINT bands, in the order the legend lists them: the protected
          reserve, CamStack's own share, everything else on the disk, then what
          is free. They are laid out in a row — no overlays — so the widths add
          up to the volume and the bar cannot misstate a proportion. */}
      <div className="relative flex h-2 w-full max-w-md overflow-hidden rounded-full bg-border">
        {bar.segments.reservePercent > 0 && (
          <div
            className={SEGMENT_CLASS.reserve}
            style={{ width: `${String(bar.segments.reservePercent)}%` }}
          />
        )}
        {bar.segments.ownedPercent !== null && (
          <div
            className={SEGMENT_CLASS.owned}
            style={{ width: `${String(bar.segments.ownedPercent)}%` }}
          />
        )}
        <div
          className={FILL_BAR_CLASS[bar.severity]}
          style={{ width: `${String(bar.segments.usedPercent)}%` }}
        />
        <div
          className={SEGMENT_CLASS.free}
          style={{ width: `${String(bar.segments.freePercent)}%` }}
        />
        {bar.segments.capPercent !== null && (
          // The cap is system-managed: a mark at the far edge our own band may
          // reach, never a handle.
          <div
            className={`absolute inset-y-0 w-px ${bar.capBelowOwned ? 'bg-danger' : SEGMENT_CLASS.cap}`}
            style={{ left: `${String(bar.segments.capPercent)}%` }}
          />
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {bar.legend.map((entry) => (
          <li key={entry.segment} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-sm ${swatchClass(entry.segment, bar.severity)}`}
            />
            <span
              className={`text-[10px] tabular-nums ${
                entry.alarming ? 'text-danger' : 'text-foreground-subtle'
              }`}
            >
              {entry.label} {entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
