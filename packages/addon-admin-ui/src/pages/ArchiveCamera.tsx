/**
 * Archive camera page (`/archive/:deviceId`) — everything about one camera's
 * footage and events: Review, Events, Exports, Health, Space, Settings.
 *
 * A row of the overview's camera table opens here. The Review player, the event
 * list and the export dialog hand each other moments and ranges through this
 * page: "Show in Review" on an event seeks the player, and a range dragged on the
 * timeline opens the export dialog.
 */
import { Badge, Checkbox, EmptyState, Select } from '@camstack/ui-library'
import { Archive as ArchiveIcon, Camera } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../components/AdminSectionedPage'
import { buildCameraHealth } from '../components/archive/camera-health'
import { cameraFindings } from '../components/archive/camera-rows'
import { ArchiveActivity } from '../components/archive/ArchiveActivity'
import {
  ArchiveHealthSection,
  cameraStatusOf,
  FUNCTION_STATE_VARIANT,
} from '../components/archive/ArchiveHealthSection'
import { ArchiveReviewSection, type ReviewSeek } from '../components/archive/ArchiveReviewSection'
import { ArchiveSettingsSection } from '../components/archive/ArchiveSettingsSection'
import { ArchiveSpaceSection } from '../components/archive/ArchiveSpaceSection'
import { useArchiveData } from '../components/archive/use-archive-data'
import { EventsSection } from '../components/detection-intelligence/EventsSection'
import { ExportsSection } from '../components/recordings/ExportsSection'
import { EventsDebugPage } from './EventsDebug'

const SECTION_PARAM = 'section'

export function ArchiveCameraPage(): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { deviceId: rawId } = useParams()
  const [, setSearchParams] = useSearchParams()
  const data = useArchiveData()
  const [seek, setSeek] = useState<ReviewSeek | undefined>(undefined)
  const [draft, setDraft] = useState<{ fromMs: number; toMs: number } | null>(null)
  const [debug, setDebug] = useState(false)

  const deviceId = rawId === undefined ? Number.NaN : Number(rawId)
  const goTo = useCallback(
    (section: string): void => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set(SECTION_PARAM, section)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  if (!Number.isFinite(deviceId)) return <Navigate to="/archive" replace />
  const row = data.rows.find((r) => r.deviceId === deviceId)
  if (!data.isLoading && row === undefined) {
    return (
      <EmptyState
        icon={Camera}
        title={t('archive.camera.unknown', 'Camera not found')}
        description={t(
          'archive.camera.unknownHint',
          'This camera is not in the Archive. Pick one from the overview.',
        )}
      />
    )
  }
  const functions = buildCameraHealth(
    cameraStatusOf(data, deviceId),
    cameraFindings(data.findings, deviceId),
  )

  return (
    <AdminSectionedPage
      icon={ArchiveIcon}
      title={row?.name ?? t('archive.camera.loading', 'Camera')}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          {functions.map((f) => (
            <Badge key={f.fn} variant={FUNCTION_STATE_VARIANT[f.state]}>
              {t(`archive.function.${f.fn}`, f.fn)} ·{' '}
              {t(`archive.functionState.${f.state}`, f.state)}
            </Badge>
          ))}
        </span>
      }
      actions={
        <Select
          wrapperClassName="inline-block w-auto"
          value={deviceId}
          onChange={(e) => navigate(`/archive/${e.target.value}`)}
          aria-label={t('archive.camera.picker', 'Camera')}
        >
          {data.cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      }
      paramName={SECTION_PARAM}
      defaultSection="review"
      sectionsLabel={t('archive.camera.sections', 'Camera sections')}
      sections={[
        {
          id: 'review',
          label: t('archive.camera.review', 'Review'),
          content: (
            <ArchiveReviewSection
              deviceId={deviceId}
              seekTo={seek}
              onExportRange={(fromMs, toMs) => {
                setDraft({ fromMs, toMs })
                goTo('exports')
              }}
            />
          ),
        },
        {
          id: 'events',
          label: t('archive.camera.events', 'Events'),
          content: (
            <div className="flex flex-col gap-3">
              <label className="flex w-fit items-center gap-2 text-xs text-foreground-subtle">
                <Checkbox checked={debug} onChange={(e) => setDebug(e.target.checked)} />
                {t('archive.camera.debugFilter', 'Debug-marked tracks only')}
              </label>
              {debug ? (
                <EventsDebugPage deviceId={deviceId} />
              ) : (
                <EventsSection
                  deviceId={deviceId}
                  onSeek={(atMs) => {
                    setSeek((prev) => ({ atMs, nonce: (prev?.nonce ?? 0) + 1 }))
                    goTo('review')
                  }}
                />
              )}
            </div>
          ),
        },
        {
          id: 'exports',
          label: t('archive.camera.exports', 'Exports'),
          content: (
            <ExportsSection deviceId={deviceId} draft={draft} onDraftClose={() => setDraft(null)} />
          ),
        },
        {
          id: 'health',
          label: t('archive.camera.health', 'Health'),
          content: (
            <div className="flex flex-col gap-6">
              <ArchiveHealthSection data={data} deviceId={deviceId} />
              <ArchiveActivity data={data} deviceId={deviceId} />
            </div>
          ),
        },
        {
          id: 'space',
          label: t('archive.camera.space', 'Space'),
          content: row === undefined ? null : <ArchiveSpaceSection data={data} row={row} />,
        },
        {
          id: 'settings',
          label: t('archive.camera.settings', 'Settings'),
          content: <ArchiveSettingsSection deviceId={deviceId} />,
        },
      ]}
    />
  )
}
