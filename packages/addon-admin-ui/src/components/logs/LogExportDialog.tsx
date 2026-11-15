/**
 * Export the logs (#570): components and/or devices over a time range, by
 * default everything over the last six hours, downloaded as one NDJSON file
 * from `GET /api/logs/export` — the route the ops MCP tool calls too.
 */

import {
  Button,
  DeviceValuePicker,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  deviceIdsOf,
  ErrorBox,
  Label,
  OptionSelect,
  pickedFromDeviceIds,
  Select,
  useAddonsList,
} from '@camstack/ui-library'
import { type JSX, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authedFetchBlob } from '../../lib/authed-media.js'
import { hubPath } from '../../lib/mount'
import { providerNamesByAddon } from '../instances/instances-model'
import {
  isLogExportRange,
  LOG_EXPORT_DEFAULT_RANGE_HOURS,
  LOG_EXPORT_RANGES_HOURS,
  type LogExportRangeHours,
  logExportFileName,
  logExportQuery,
} from './log-export-url'

export interface LogExportDialogProps {
  readonly onClose: () => void
}

function saveBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

export function LogExportDialog({ onClose }: LogExportDialogProps): JSX.Element {
  const { t } = useTranslation()
  const addonsQuery = useAddonsList(undefined)
  const [components, setComponents] = useState<string[]>([])
  const [deviceIds, setDeviceIds] = useState<number[]>([])
  const [rangeHours, setRangeHours] = useState<LogExportRangeHours>(LOG_EXPORT_DEFAULT_RANGE_HOURS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentOptions = useMemo(
    () =>
      [...providerNamesByAddon(addonsQuery.data ?? []).entries()]
        .map(([value, label]) => ({ value, label, description: value }))
        .toSorted((a, b) => a.label.localeCompare(b.label)),
    [addonsQuery.data],
  )

  const rangeOptions = LOG_EXPORT_RANGES_HOURS.map((hours) => ({
    value: String(hours),
    label: t('admin.system.logs.export.lastHours', 'Last {{hours}} h', { hours }),
  }))

  const runExport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const now = Date.now()
    try {
      const blob = await authedFetchBlob(
        `${hubPath('/api/logs/export')}${logExportQuery({ components, deviceIds, rangeHours }, now)}`,
      )
      saveBlob(blob, logExportFileName(now))
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('admin.system.logs.export.title', 'Export logs')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-foreground-muted">
            {t(
              'admin.system.logs.export.hint',
              'Downloads one NDJSON file, one line per entry with its tags. Leave a filter empty to include everything.',
            )}
          </p>
          <div className="space-y-1">
            <Label htmlFor="log-export-components">
              {t('admin.system.logs.export.components', 'Components')}
            </Label>
            <OptionSelect
              mode="multi"
              listboxId="log-export-components"
              placeholder={t('admin.system.logs.export.allComponents', 'All components')}
              options={componentOptions}
              value={components}
              onChange={setComponents}
              searchable
              testId="log-export-components"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="log-export-devices">
              {t('admin.system.logs.export.devices', 'Devices')}
            </Label>
            <DeviceValuePicker
              id="log-export-devices"
              multiple
              pick="device"
              testId="log-export-devices"
              value={pickedFromDeviceIds(deviceIds)}
              onChange={(next) => setDeviceIds(deviceIdsOf(next))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="log-export-range">
              {t('admin.system.logs.export.range', 'Time range')}
            </Label>
            <Select
              id="log-export-range"
              options={rangeOptions}
              value={String(rangeHours)}
              onChange={(e) => {
                const hours = Number(e.target.value)
                if (isLogExportRange(hours)) setRangeHours(hours)
              }}
            />
          </div>
          {error !== null && (
            <ErrorBox
              title={t('admin.system.logs.export.failed', 'The export failed')}
              message={error}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void runExport()}
            disabled={busy}
            data-testid="log-export-download"
          >
            {busy
              ? t('admin.system.logs.export.downloading', 'Downloading…')
              : t('admin.system.logs.export.download', 'Download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
