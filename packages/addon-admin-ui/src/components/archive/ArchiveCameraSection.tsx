/**
 * Archive → Cameras (`/archive?section=cameras&camera=<id>&view=…`): one
 * camera's workspace. The camera is picked in the section header — there is
 * no camera list here, the overview's table is the list — and the workspace
 * has three views on a secondary pill row: Review (default), Health & space,
 * Settings. Camera and view live in the URL, replaced, so a reload keeps them.
 */
import {
  Badge,
  EmptyState,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@camstack/ui-library'
import { Camera } from 'lucide-react'
import { useCallback, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { ArchiveActivity } from './ArchiveActivity'
import {
  ArchiveHealthSection,
  cameraStatusOf,
  FUNCTION_STATE_VARIANT,
} from './ArchiveHealthSection'
import { ArchiveReviewSection } from './ArchiveReviewSection'
import { ArchiveSettingsSection } from './ArchiveSettingsSection'
import { ArchiveSpaceSection } from './ArchiveSpaceSection'
import { CAMERA_PARAM, VIEW_PARAM } from './archive-redirects'
import { buildCameraHealth } from './camera-health'
import { cameraFindings } from './camera-rows'
import type { ArchiveData } from './use-archive-data'

const VIEWS = ['review', 'health', 'settings'] as const
type ArchiveCameraView = (typeof VIEWS)[number]

function isView(value: string | null): value is ArchiveCameraView {
  return VIEWS.some((v) => v === value)
}

export interface ArchiveCameraSectionProps {
  readonly data: ArchiveData
}

export function ArchiveCameraSection({ data }: ArchiveCameraSectionProps): ReactElement {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const rawCamera = params.get(CAMERA_PARAM)
  const rawView = params.get(VIEW_PARAM)
  const view: ArchiveCameraView = isView(rawView) ? rawView : 'review'
  const deviceId = rawCamera === null ? (data.cameras[0]?.id ?? null) : Number(rawCamera)

  const setParam = useCallback(
    (key: string, value: string): void => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set(key, value)
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  if (deviceId === null || !Number.isFinite(deviceId)) {
    return (
      <EmptyState
        icon={Camera}
        title={t('archive.camera.none', 'No cameras yet')}
        description={t('archive.camera.noneHint', 'Cameras appear here once one is added.')}
      />
    )
  }
  const row = data.rows.find((r) => r.deviceId === deviceId)
  const functions = buildCameraHealth(
    cameraStatusOf(data, deviceId),
    cameraFindings(data.findings, deviceId),
  )

  return (
    <div className="flex flex-col gap-3" data-testid="archive-camera-section">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          wrapperClassName="inline-block w-auto"
          value={deviceId}
          onChange={(e) => setParam(CAMERA_PARAM, e.target.value)}
          aria-label={t('archive.camera.picker', 'Camera')}
        >
          {data.cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {functions.map((f) => (
          <Badge key={f.fn} variant={FUNCTION_STATE_VARIANT[f.state]}>
            {t(`archive.function.${f.fn}`, f.fn)} · {t(`archive.functionState.${f.state}`, f.state)}
          </Badge>
        ))}
      </div>

      {!data.isLoading && row === undefined ? (
        <EmptyState
          icon={Camera}
          title={t('archive.camera.unknown', 'Camera not found')}
          description={t(
            'archive.camera.unknownHint',
            'This camera is not in the Archive. Pick one from the overview.',
          )}
        />
      ) : (
        <Tabs
          appearance="pills"
          value={view}
          onValueChange={(next) => setParam(VIEW_PARAM, next)}
          className="flex flex-col gap-3"
        >
          <TabsList aria-label={t('archive.camera.sections', 'Camera sections')}>
            <TabsTrigger value="review">{t('archive.camera.review', 'Review')}</TabsTrigger>
            <TabsTrigger value="health">
              {t('archive.camera.healthSpace', 'Health & space')}
            </TabsTrigger>
            <TabsTrigger value="settings">{t('archive.camera.settings', 'Settings')}</TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            <ArchiveReviewSection deviceId={deviceId} />
          </TabsContent>
          <TabsContent value="health">
            <div className="flex flex-col gap-6">
              <ArchiveHealthSection data={data} deviceId={deviceId} />
              <ArchiveActivity data={data} deviceId={deviceId} />
              {row !== undefined && <ArchiveSpaceSection data={data} row={row} />}
            </div>
          </TabsContent>
          <TabsContent value="settings">
            <ArchiveSettingsSection deviceId={deviceId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
