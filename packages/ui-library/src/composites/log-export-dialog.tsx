/**
 * Export the logs (#570): components and/or devices over a time range, from a
 * chosen log source, downloaded as one NDJSON file from `GET /api/logs/export`
 * — the route the ops MCP tool calls too.
 *
 * Opened from a `LogStream`'s toolbar, pre-filled with that stream's scope
 * (`logExportScopeOf`). Each source says whether it can be read, and how far
 * back it reaches; a range longer than that reach is brought down to it and
 * the dialog says so.
 */
import { type JSX, useMemo, useState } from 'react'
import { useUiText } from '../contexts/ui-text'
import { useAddonsList } from '../generated/system-hooks'
import { hubPath } from '../lib/hub-mount'
import { Badge } from '../primitives/badge'
import { Button } from '../primitives/button'
import { Checkbox } from '../primitives/checkbox'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../primitives/dialog'
import { Label } from '../primitives/label'
import { Select } from '../primitives/select'
import { trpc } from '../trpc-react'
import { deviceIdsOf, pickedFromDeviceIds } from './device-value-picker/device-id-values'
import { DeviceValuePicker } from './device-value-picker/DeviceValuePicker'
import { ErrorBox } from './error-box'
import {
  clampRangeToReach,
  initialExportSource,
  isLogExportRange,
  LOG_EXPORT_DEFAULT_RANGE_HOURS,
  type LogExportRangeHours,
  type LogExportScope,
  logExportFileName,
  logExportQuery,
  rangesWithinReach,
  sourceReach,
} from './log-export'
import { addonNameIndex } from './log-stream-names'
import { OptionSelect } from './option-select'

/** The host's session token, as every admin-side data-plane fetch reads it. */
const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

export type LogExportFetch = (url: string) => Promise<Blob>

async function defaultFetchBlob(url: string): Promise<Blob> {
  let token: string | null = null
  try {
    token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  } catch {
    token = null
  }
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
  if (!res.ok) throw new Error(`export failed: ${String(res.status)}`)
  return res.blob()
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

export interface LogExportDialogProps {
  /** The stream's scope: the starting point of the components, devices and source. */
  readonly initial: LogExportScope
  readonly onClose: () => void
  /** Replaces the authenticated download (a host with another session mechanism, tests). */
  readonly fetchBlob?: LogExportFetch
}

export function LogExportDialog({
  initial,
  onClose,
  fetchBlob,
}: LogExportDialogProps): JSX.Element {
  const t = useUiText()
  const addonsQuery = useAddonsList(undefined)
  const sourcesQuery = trpc.logs.sources.useQuery(undefined, { staleTime: 60_000 })
  const [components, setComponents] = useState<string[]>([...initial.components])
  const [deviceIds, setDeviceIds] = useState<number[]>([...initial.deviceIds])
  const [rangeHours, setRangeHours] = useState<LogExportRangeHours>(LOG_EXPORT_DEFAULT_RANGE_HOURS)
  const [sourceChoice, setSourceChoice] = useState<string | undefined>(undefined)
  const [zip, setZip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const names = useMemo(() => addonNameIndex(addonsQuery.data), [addonsQuery.data])
  const sources = sourcesQuery.data
  const source =
    sourceChoice ??
    (sources === undefined ? initial.source : initialExportSource(initial.source, sources))
  const sourceInfo = sources?.find((s) => s.addonId === source)
  const retentionDays = sourceInfo?.retentionDays ?? null
  const effectiveRange = clampRangeToReach(rangeHours, retentionDays)

  const componentOptions = useMemo(
    () =>
      [...names.entries()]
        .map(([value, label]) => ({ value, label, description: value }))
        .toSorted((a, b) => a.label.localeCompare(b.label)),
    [names],
  )
  const rangeOptions = rangesWithinReach(retentionDays).map((hours) => ({
    value: String(hours),
    label: t('uiLibrary.logExport.lastHours', 'Last {{hours}} h', { hours }),
  }))

  const runExport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const now = Date.now()
    try {
      const blob = await (fetchBlob ?? defaultFetchBlob)(
        `${hubPath('/api/logs/export')}${logExportQuery(
          { components, deviceIds, rangeHours: effectiveRange, source, zip },
          now,
        )}`,
      )
      saveBlob(blob, logExportFileName(now, zip))
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
          <DialogTitle>{t('uiLibrary.logExport.title', 'Export logs')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-foreground-muted">
            {t(
              'uiLibrary.logExport.hint',
              'Downloads one NDJSON file, one line per entry with its tags. Leave the components and devices empty to export the whole system log.',
            )}
          </p>
          <fieldset className="space-y-1" data-testid="log-export-sources">
            <legend className="mb-1 text-[11px] font-medium text-foreground">
              {t('uiLibrary.logExport.source', 'Log source')}
            </legend>
            {sourcesQuery.isError ? (
              <ErrorBox
                variant="warning"
                title={t('uiLibrary.logExport.sourcesFailed', 'The log sources could not be read')}
                message={t(
                  'uiLibrary.logExport.sourcesFailedHint',
                  'The export falls back to the default log source.',
                )}
              />
            ) : sources === undefined ? (
              <p className="text-xs text-foreground-subtle">
                {t('uiLibrary.logExport.sourcesLoading', 'Reading the log sources…')}
              </p>
            ) : (
              sources.map((entry) => {
                const reach = sourceReach(entry)
                return (
                  <label
                    key={entry.addonId}
                    className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs has-[:disabled]:opacity-60"
                  >
                    <input
                      type="radio"
                      name="log-export-source"
                      className="mt-0.5 accent-primary"
                      checked={entry.addonId === source}
                      disabled={!entry.readable}
                      onChange={() => setSourceChoice(entry.addonId)}
                      data-testid={`log-export-source-${entry.addonId}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">
                        {names.get(entry.addonId) ?? entry.addonId}
                      </span>
                      {reach.kind === 'unreadable' && (
                        <span className="block text-foreground-subtle">
                          {reach.reason ??
                            t(
                              'uiLibrary.logExport.unreadableNoReason',
                              'This destination only ships lines.',
                            )}
                        </span>
                      )}
                    </span>
                    {reach.kind === 'unreadable' ? (
                      <Badge variant="default">
                        {t('uiLibrary.logExport.notReadable', 'Not readable')}
                      </Badge>
                    ) : reach.kind === 'days' ? (
                      <Badge variant="success">
                        {t(
                          'uiLibrary.logExport.reachDays',
                          { one: 'Back {{count}} day', other: 'Back {{count}} days' },
                          { count: reach.days },
                        )}
                      </Badge>
                    ) : (
                      <Badge variant="default">
                        {t('uiLibrary.logExport.reachUnknown', 'Reach unknown')}
                      </Badge>
                    )}
                  </label>
                )
              })
            )}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="log-export-components">
              {t('uiLibrary.logExport.components', 'Components')}
            </Label>
            <OptionSelect
              mode="multi"
              listboxId="log-export-components"
              placeholder={t('uiLibrary.logExport.allComponents', 'All components')}
              options={componentOptions}
              value={components}
              onChange={setComponents}
              searchable
              testId="log-export-components"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="log-export-devices">
              {t('uiLibrary.logExport.devices', 'Devices')}
            </Label>
            <DeviceValuePicker
              id="log-export-devices"
              multiple
              pick="device"
              stableHeight
              testId="log-export-devices"
              value={pickedFromDeviceIds(deviceIds)}
              onChange={(next) => setDeviceIds(deviceIdsOf(next))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="log-export-range">{t('uiLibrary.logExport.range', 'Time range')}</Label>
            <Select
              id="log-export-range"
              options={rangeOptions}
              value={String(effectiveRange)}
              onChange={(e) => {
                const hours = Number(e.target.value)
                if (isLogExportRange(hours)) setRangeHours(hours)
              }}
            />
            {effectiveRange !== rangeHours && retentionDays !== null && (
              <ErrorBox
                variant="warning"
                message={t(
                  'uiLibrary.logExport.rangeClamped',
                  'This source keeps {{days}} days: the range was shortened to fit.',
                  { days: retentionDays },
                )}
              />
            )}
            {sourceInfo !== undefined && retentionDays === null && (
              <p className="text-[11px] text-foreground-subtle">
                {t(
                  'uiLibrary.logExport.reachUnknownHint',
                  'How far back this source reaches is unknown: an older range may return fewer lines.',
                )}
              </p>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              className="mt-0.5"
              checked={zip}
              onChange={(e) => setZip(e.target.checked)}
              data-testid="log-export-zip"
            />
            <span>{t('uiLibrary.logExport.zip', 'Export as ZIP')}</span>
          </label>
          {error !== null && (
            <ErrorBox
              title={t('uiLibrary.logExport.failed', 'The export failed')}
              message={error}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('uiLibrary.logExport.cancel', 'Cancel')}
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
              ? t('uiLibrary.logExport.downloading', 'Downloading…')
              : t('uiLibrary.logExport.download', 'Download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
