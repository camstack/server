/**
 * NewExportModal — create a recording export FROM the admin Recordings page
 * (operator ask, 2026-07-29; the flow previously lived only in the viewer's
 * camera-screen range picker).
 *
 * Camera + profile + time range (+ optional speed) → `recordingExport
 * .createExport`. The engine fails fast when no footage covers the range, and
 * that message is surfaced verbatim. The row then appears in the exports list
 * via the caller's refetch.
 */

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDeviceManagerListAll,
  useRecordingExportCreateExport,
} from '@camstack/ui-library'
import { Film } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface NewExportModalProps {
  readonly onClose: () => void
  readonly onCreated: () => void
}

const PROFILES = ['high', 'mid', 'low'] as const
const SPEEDS = [
  { value: 1, labelKey: 'recordings.newExportModal.speedRealTime' },
  { value: 2, labelKey: null },
  { value: 4, labelKey: null },
  { value: 8, labelKey: null },
  { value: 16, labelKey: null },
] as const
/** Rendered clips self-delete after a week unless downloaded earlier. */
const EXPORT_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/** `datetime-local` value for "now minus `minsAgo` minutes", in local time. */
function localInputValue(minsAgo: number): string {
  const d = new Date(Date.now() - minsAgo * 60_000)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
}

export function NewExportModal({ onClose, onCreated }: NewExportModalProps) {
  const { t } = useTranslation()
  // Cameras only, filtered server-side, slim, and the query client's fleet window (D274) so
  // this shares one fetch with the other recordings-page sections.
  const devicesQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const cameras = useMemo(
    () => (devicesQuery.data ?? []).toSorted((a, b) => a.name.localeCompare(b.name)),
    [devicesQuery.data],
  )
  const [deviceId, setDeviceId] = useState<number | ''>('')
  const [profile, setProfile] = useState<string>('high')
  const [from, setFrom] = useState<string>(localInputValue(60))
  const [to, setTo] = useState<string>(localInputValue(0))
  const [speed, setSpeed] = useState<number>(1)
  const [includeAudio, setIncludeAudio] = useState(true)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const effectiveDeviceId = deviceId === '' ? (cameras[0]?.id ?? null) : deviceId
  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()
  const rangeValid = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs

  const create = useRecordingExportCreateExport({
    onSuccess: () => {
      onCreated()
      onClose()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const submit = (): void => {
    if (effectiveDeviceId === null || !rangeValid) return
    setError(null)
    const trimmedTitle = title.trim()
    create.mutate({
      deviceId: effectiveDeviceId,
      profile,
      fromMs,
      toMs,
      options: {
        includeAudio,
        maxLifeMs: EXPORT_LIFE_MS,
        deleteAfterDownload: false,
        ...(speed !== 1 ? { speed } : {}),
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      },
    })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Film className="h-3.5 w-3.5" />
            {t('recordings.newExportModal.newExport', 'New export')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.camera', 'Camera')}
              </label>
              <select
                value={effectiveDeviceId ?? ''}
                onChange={(e) => setDeviceId(Number(e.target.value))}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              >
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.profile', 'Profile')}
              </label>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              >
                {PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.from', 'From')}
              </label>
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.to', 'To')}
              </label>
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.speed', 'Speed')}
              </label>
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              >
                {SPEEDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.labelKey !== null ? t(s.labelKey) : `${s.value}×`}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('recordings.newExportModal.titleOptional', 'Title (optional)')}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t(
                  'recordings.newExportModal.eGCourierAtThe',
                  'e.g. courier at the gate',
                )}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-foreground-subtle"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={speed !== 1}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              className="accent-primary"
            />
            {speed !== 1
              ? t('recordings.newExportModal.includeAudioRealtimeOnly')
              : t('recordings.newExportModal.includeAudio')}
          </label>
          {!rangeValid && (
            <p className="text-[11px] text-danger">
              {t('recordings.newExportModal.fromMustBeBeforeTo', '"From" must be before "To".')}
            </p>
          )}
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={effectiveDeviceId === null || !rangeValid || create.isPending}
          >
            {create.isPending
              ? t('recordings.newExportModal.queuing', 'Queuing…')
              : t('recordings.newExportModal.createExport', 'Create export')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
