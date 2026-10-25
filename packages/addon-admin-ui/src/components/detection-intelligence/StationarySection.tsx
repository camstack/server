/**
 * StationarySection — the Events page's dedicated "Stationary" section.
 *
 * Parked objects (a car in a lot, a bin) that stopped moving are PROMOTED by
 * the analytics addon to lightweight registry entries: they no longer re-spawn
 * tracks/events, so they must NOT appear in the key-event feed. This section
 * lists them separately (per camera, with the parked object's key frame), so
 * the operator can still see "what is currently parked here" without the feed
 * being flooded by the same static cars every few minutes.
 *
 * Data comes from the occupancy snapshot's additive `stationaryObjects` field
 * (`useStationaryObjects` fan-out); collapsed by default so it never competes
 * with the live feed for attention.
 */

import { useDeviceManagerListAll } from '@camstack/ui-library'
import { ChevronDown, ChevronRight, ParkingSquare } from 'lucide-react'
import { type JSX, useMemo, useState } from 'react'
import { mediaIdPath, useAuthedImage } from '../../lib/authed-media.js'
import { type StationaryRow, useStationaryObjects } from './use-stationary-objects.js'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

function parkedSince(nowMs: number, becameStationaryAt: number): string {
  const mins = Math.max(0, Math.round((nowMs - becameStationaryAt) / 60_000))
  if (mins < 1) return i18n.t('helpers.relativeTime.justNow')
  if (mins < 60) return `${String(mins)}m`
  const hrs = Math.floor(mins / 60)
  return `${String(hrs)}h ${String(mins % 60)}m`
}

function StationaryCard({
  row,
  cameraName,
  nowMs,
}: {
  row: StationaryRow
  cameraName: string
  nowMs: number
}): JSX.Element {
  const { t } = useTranslation()
  // `row.keyFrameMediaId` is the media row's OWN id (D482) — no owner-key
  // parsing needed any more. Before D482 this was a composite MediaStore key
  // (`track:<id>:keyFrame:<ts>`) and the route resolved by the OWNER id
  // extracted from it; a numeric row id addresses the row directly.
  const img = useAuthedImage(
    row.keyFrameMediaId !== undefined ? mediaIdPath(row.keyFrameMediaId) : undefined,
  )
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="relative aspect-video overflow-hidden bg-surface-hover">
        {img.src ? (
          <img
            src={img.src}
            alt={t(
              'detectionIntelligence.stationarySection.parkedOn',
              'Parked {{className}} on {{cameraName}}',
              { className: row.className, cameraName },
            )}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-foreground-subtle">
            <ParkingSquare className="h-6 w-6" />
          </div>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium capitalize text-white">
          {row.label ?? row.className}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        <span className="truncate text-[11px] text-foreground">{cameraName}</span>
        <span className="text-[10px] text-foreground-subtle">
          {t('common.parkedSince', { since: parkedSince(nowMs, row.becameStationaryAt) })}
        </span>
      </div>
    </div>
  )
}

export function StationarySection(): JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const nowMs = Date.now()

  // Cameras only, slim (no config/metadata) — filtered server-side rather
  // than fetching the whole smart-home and discarding non-cameras client
  // side. The caching window is the query client's, shared with every other
  // camera-roster read in this app (CameraPipelineCard, Retrain, Scenes): the
  // fleet does not change every second, and one owner is what lets sibling
  // sections on this page share a fetch rather than each re-triggering their
  // own (D274).
  const { data: cameras = [] } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const deviceIds = useMemo(() => cameras.map((d) => d.id), [cameras])
  const nameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const d of cameras) m.set(d.id, d.name)
    return m
  }, [cameras])

  const { rows, unreadableCount } = useStationaryObjects(deviceIds)

  // Nothing parked anywhere → don't render the section at all (no clutter).
  //
  // "Nothing parked" is a claim, and it may only be made about cameras that
  // ANSWERED. A camera the owner could not read contributes no rows, and
  // hiding the section on that basis would turn an unread camera into a
  // positive statement that nothing is parked on it. So an unreadable camera
  // keeps the section visible and is named in the header.
  if (rows.length === 0 && unreadableCount === 0) return null

  return (
    <div className="rounded-md border border-border bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-foreground-subtle" />
        ) : (
          <ChevronRight className="h-4 w-4 text-foreground-subtle" />
        )}
        <ParkingSquare className="h-4 w-4 text-foreground-subtle" />
        <span className="text-sm font-semibold text-foreground">
          {t('detectionIntelligence.stationarySection.stationary', 'Stationary')}
        </span>
        <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-foreground-subtle">
          {rows.length}
        </span>
        <span className="ml-2 text-[11px] text-foreground-subtle">
          {t(
            'detectionIntelligence.stationarySection.parkedObjectsKeptOutOf',
            'Parked objects — kept out of the event feed',
          )}
        </span>
        {unreadableCount > 0 ? (
          <span className="ml-2 text-[11px] text-warning">
            {t('detectionIntelligence.stationarySection.unreadable', { count: unreadableCount })}
          </span>
        ) : null}
      </button>
      {open && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 p-3 pt-0">
          {rows.map((row) => (
            <StationaryCard
              key={row.id}
              row={row}
              cameraName={nameById.get(row.deviceId) ?? `Camera #${String(row.deviceId)}`}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}
    </div>
  )
}
