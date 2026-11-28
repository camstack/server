/**
 * Archive camera page → Health: one row per function (recording, motion,
 * detection, event media) from the camera's status and the health digest's
 * findings for this deviceId, then the camera's own log.
 *
 * Off is not broken (D62); an unread stage is unknown, not fine (D315).
 */
import { Badge, type BadgeVariant, LogStream } from '@dominevo/ui-library'
import type { CameraStatus } from '@dominevo/types'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { buildCameraHealth, type FunctionState } from './camera-health'
import { cameraFindings } from './camera-rows'
import type { ArchiveData } from './use-archive-data'

export const FUNCTION_STATE_VARIANT: Readonly<Record<FunctionState, BadgeVariant>> = {
  ok: 'success',
  off: 'default',
  warning: 'warning',
  critical: 'danger',
  unknown: 'default',
}

export function cameraStatusOf(data: ArchiveData, deviceId: number): CameraStatus | undefined {
  return data.statuses?.find((s) => s.deviceId === deviceId)
}

export function ArchiveHealthSection({
  data,
  deviceId,
}: {
  readonly data: ArchiveData
  readonly deviceId: number
}): ReactElement {
  const { t } = useTranslation()
  const functions = buildCameraHealth(
    cameraStatusOf(data, deviceId),
    cameraFindings(data.findings, deviceId),
  )

  return (
    <div className="flex flex-col gap-4" data-testid="archive-health">
      {data.findings === null && (
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'archive.health.noDigest',
            'The health digest has not run yet — findings are not available.',
          )}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {functions.map((f) => (
          <li key={f.fn} className="flex flex-col gap-1 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                {t(`archive.function.${f.fn}`, f.fn)}
              </span>
              <Badge variant={FUNCTION_STATE_VARIANT[f.state]}>
                {t(`archive.functionState.${f.state}`, f.state)}
              </Badge>
            </div>
            {f.findings.map((finding) => (
              <div key={finding.id} className="text-[11px] text-foreground-subtle">
                <span className="text-foreground">{finding.what}</span> — {finding.action}
              </div>
            ))}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t('archive.health.logs', 'Camera log')}
          </h3>
          <Link
            className="text-xs text-primary hover:underline"
            to={`/system/logs?deviceId=${String(deviceId)}`}
          >
            {t('archive.health.openLogs', 'Open in Logs')}
          </Link>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <LogStream deviceId={deviceId} limit={100} maxHeight="max-h-80" showFilters />
        </div>
      </div>
    </div>
  )
}
