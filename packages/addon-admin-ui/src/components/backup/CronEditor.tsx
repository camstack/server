/**
 * `CronEditor` — modal-friendly inline editor for a per-destination
 * backup cron expression. Two surfaces:
 *
 *   1. Preset buttons that snap to a curated set of common patterns
 *      (manual, hourly, every 3h, every 6h, daily 03:00, weekly Sun).
 *      "Custom" enables free-form editing.
 *   2. A free-form `<input>` for raw cron expressions, paired with a
 *      live next-run preview powered by `backup.previewSchedule` —
 *      validates server-side via `croner` so the operator sees parse
 *      errors inline instead of after save.
 *
 * Why server-side preview vs. client-side parse: keeping the cron
 * grammar locked to the orchestrator's exact croner version (5-field
 * POSIX, DST-aware) avoids drift where client-rendered preview lies
 * about what the scheduler will actually do at tick time.
 *
 * The component is **fully controlled** — `value` is the single source
 * of truth, and every keystroke / preset click fires `onChange`. An
 * earlier draft kept an internal draft state that synced on blur, but
 * that meant a Save click without first blurring the input read stale
 * state. Controlled-only avoids that footgun.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useBackupPreviewSchedule } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

interface CronPreset {
  readonly id: string
  readonly labelKey: string
  readonly cron: string
  readonly descriptionKey?: string
  /** Language-neutral description (clock times), shown as is. */
  readonly description?: string
}

const PRESETS: readonly CronPreset[] = [
  { id: 'manual', labelKey: 'backup.cronEditor.presetManual', cron: '' },
  {
    id: 'hourly',
    labelKey: 'backup.cronEditor.presetHourly',
    cron: '0 * * * *',
    descriptionKey: 'backup.cronEditor.presetHourlyDesc',
  },
  {
    id: 'every-3h',
    labelKey: 'backup.cronEditor.preset3h',
    cron: '0 */3 * * *',
    description: '00:00, 03:00, 06:00, 09:00 …',
  },
  {
    id: 'every-6h',
    labelKey: 'backup.cronEditor.preset6h',
    cron: '0 */6 * * *',
    description: '00:00, 06:00, 12:00, 18:00',
  },
  {
    id: 'daily-3am',
    labelKey: 'backup.cronEditor.presetDaily',
    cron: '0 3 * * *',
    descriptionKey: 'backup.cronEditor.presetDailyDesc',
  },
  {
    id: 'weekly-sun',
    labelKey: 'backup.cronEditor.presetWeekly',
    cron: '0 3 * * 0',
    descriptionKey: 'backup.cronEditor.presetWeeklyDesc',
  },
]

export interface CronEditorProps {
  /** Current cron expression. Empty string = manual-only. */
  readonly value: string
  readonly onChange: (next: string) => void
  /** Number of next-run rows to render in the preview. Defaults to 5. */
  readonly previewCount?: number
  /** Disable the controls (e.g. while a save is pending). */
  readonly disabled?: boolean
}

/** Wire shape returned by `backup.previewSchedule`. */
interface PreviewResult {
  readonly ok: boolean
  readonly error?: string
  readonly nextRuns: readonly number[]
}

function detectPreset(value: string): string {
  const trimmed = value.trim()
  for (const p of PRESETS) {
    if (p.cron === trimmed) return p.id
  }
  return 'custom'
}

export function CronEditor({
  value,
  onChange,
  previewCount = 5,
  disabled = false,
}: CronEditorProps) {
  const { t } = useTranslation()
  const matchedPreset = detectPreset(value)
  // Sticky flag — the operator can request the custom input even when
  // `value` happens to match a preset. We can't infer this from the
  // value alone (string-equality with a preset is ambiguous intent),
  // so an explicit click on "Custom…" pins it.
  const [customForced, setCustomForced] = useState<boolean>(matchedPreset === 'custom')

  // Reset the sticky-custom flag when the value flips back to a real
  // preset (e.g. a fresh open of the modal lands on Daily 03:00 → the
  // preset chip should be active, not the custom input).
  useEffect(() => {
    if (matchedPreset !== 'custom') setCustomForced(false)
  }, [matchedPreset])

  const debounced = useDebouncedString(value, 250)

  const previewQuery = useBackupPreviewSchedule(
    { cron: debounced, count: previewCount },
    { enabled: debounced.trim().length > 0 },
  )
  const preview = (previewQuery.data ?? null) as PreviewResult | null

  const handlePreset = (preset: CronPreset): void => {
    setCustomForced(false)
    onChange(preset.cron)
  }

  const isCustomActive = customForced || matchedPreset === 'custom'

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('backup.cronEditor.schedulePreset', 'Schedule preset')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => {
            const isActive = !customForced && matchedPreset === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePreset(p)}
                disabled={disabled}
                className={
                  'rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ' +
                  (isActive
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-foreground-subtle hover:bg-primary/5 hover:text-foreground')
                }
                title={
                  p.descriptionKey !== undefined
                    ? t(p.descriptionKey)
                    : (p.description ?? t(p.labelKey))
                }
              >
                {t(p.labelKey)}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => {
              setCustomForced(true)
              // Seed a sensible starting expression only when there's
              // nothing useful to edit — otherwise keep the operator's
              // current cron so they can tweak it field-by-field.
              if (value.trim().length === 0) {
                onChange('0 3 * * *')
              }
            }}
            disabled={disabled}
            className={
              'rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ' +
              (isCustomActive
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-foreground-subtle hover:bg-primary/5 hover:text-foreground')
            }
          >
            {t('backup.cronEditor.custom', 'Custom…')}
          </button>
        </div>
      </div>

      {isCustomActive && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
            {t('backup.cronEditor.cronExpression5FieldPosix', 'Cron expression (5-field POSIX)')}
          </div>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="0 3 * * *"
            spellCheck={false}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="text-[10px] text-foreground-subtle">
            {t('backup.cronEditor.format', 'Format:')}{' '}
            <Trans
              i18nKey="backup.cronEditor.formatLine"
              components={{ code: <span className="font-mono" /> }}
            />
          </p>
        </div>
      )}

      <PreviewBlock cron={debounced} preview={preview} loading={previewQuery.isFetching} />
    </div>
  )
}

interface PreviewBlockProps {
  readonly cron: string
  readonly preview: PreviewResult | null
  readonly loading: boolean
}

function PreviewBlock({ cron: _cron, preview, loading }: PreviewBlockProps) {
  const { t } = useTranslation()
  if (loading && preview === null) {
    return (
      <div className="flex items-center gap-2 rounded border border-border bg-background/40 px-3 py-2 text-[11px] text-foreground-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('backup.cronEditor.validating', 'Validating…')}
      </div>
    )
  }
  if (preview === null) {
    return null
  }
  if (!preview.ok) {
    return (
      <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
        {preview.error ?? t('backup.cronEditor.invalidCronExpression', 'Invalid cron expression')}
      </div>
    )
  }
  if (preview.nextRuns.length === 0) {
    return (
      <div className="rounded border border-border bg-background/40 px-3 py-2 text-[11px] text-foreground-subtle">
        {t('backup.cronEditor.noFutureRunsMatchThis', 'No future runs match this expression.')}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
        {t('backup.cronEditor.nextRuns', 'Next runs')}
      </div>
      <ul className="rounded border border-border bg-background/40 divide-y divide-border">
        {preview.nextRuns.map((ts, idx) => (
          <li
            key={`${ts}-${idx}`}
            className="flex items-center justify-between px-3 py-1.5 text-[11px]"
          >
            <span className="text-foreground tabular-nums">{new Date(ts).toLocaleString()}</span>
            <span className="text-foreground-subtle text-[10px] tabular-nums">
              {formatRelativeFuture(ts)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatRelativeFuture(ts: number): string {
  const delta = ts - Date.now()
  if (delta <= 0) return i18n.t('helpers.relativeTime.now')
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return i18n.t('helpers.relativeTime.inSeconds', { count: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return i18n.t('helpers.relativeTime.inMinutes', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return i18n.t('helpers.relativeTime.inHours', { count: hr })
  const days = Math.floor(hr / 24)
  return i18n.t('helpers.relativeTime.inDays', { count: days })
}

/**
 * Local debounce — duplicates the `useDebouncedString` ui-library
 * hook to keep this component standalone.
 */
function useDebouncedString(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState<string>(value)
  const stableValue = useMemo(() => value, [value])
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(stableValue), delayMs)
    return () => clearTimeout(handle)
  }, [stableValue, delayMs])
  return debounced
}
