/**
 * Autotrack settings card — rendered inside the PTZ panel when the
 * device has `DeviceFeature.PtzAutotrack`. Three knobs (cross-vendor
 * schema): target type, stop delay, disappear delay, plus an enable /
 * disable toggle that drives the `ptz-autotrack` cap directly.
 *
 * Save semantics:
 *   - Toggle (enable/disable) calls `setEnabled` immediately.
 *   - Form fields debounce-save on blur — no explicit Save button.
 *
 * Vendor capability hints:
 *   - The cap's status carries `currentSettings` from the camera's
 *     own GET; rendered on every poll so the operator sees what's
 *     really applied vs what they typed.
 *   - When the firmware ignored a setting, the field stays editable.
 */
import { Select } from '../../primitives/select'
import { useUiText } from '../../contexts/ui-text'
import { useEffect, useRef, useState, type JSX } from 'react'
import { Crosshair, Loader2, AlertCircle } from 'lucide-react'
import type { PtzAutotrackSettings } from '@camstack/types'
import { useDeviceAutotrack } from '../../hooks/use-device-autotrack'
import { WidgetPanel } from '../widget-panel'
import { DurationInput } from '../duration-input/DurationInput'
import { FormSaveBar } from '../form-save-bar'

interface AutotrackSectionProps {
  readonly deviceId: number
}

export function AutotrackSection({ deviceId }: AutotrackSectionProps): JSX.Element {
  const t = useUiText()
  const { status, isLoading, isPending, error, setEnabled, setSettings } = useDeviceAutotrack(
    Number.isFinite(deviceId) ? deviceId : null,
  )

  // Local copy of the form values — initialised from `status` and edited
  // freely until Save sends the changed ones through the cap's setSettings.
  // The 5 s polling refresh never overwrites a typed, not yet saved value.
  const [draft, setDraft] = useState<PtzAutotrackSettings>({
    targetType: '',
    stopDelaySeconds: 30,
    disappearDelaySeconds: 15,
  })
  // The draft follows the server only while it is untouched.
  const synced = useRef<PtzAutotrackSettings | null>(null)
  useEffect(() => {
    const stored = status?.currentSettings
    if (!stored) return
    const previous = synced.current
    setDraft((current) =>
      previous === null || sameSettings(current, previous) ? { ...stored } : current,
    )
    synced.current = { ...stored }
  }, [status])

  const stored = status?.currentSettings
  const patch: Partial<PtzAutotrackSettings> = {
    ...(stored && draft.targetType !== stored.targetType ? { targetType: draft.targetType } : {}),
    ...(stored && draft.stopDelaySeconds !== stored.stopDelaySeconds
      ? { stopDelaySeconds: draft.stopDelaySeconds }
      : {}),
    ...(stored && draft.disappearDelaySeconds !== stored.disappearDelaySeconds
      ? { disappearDelaySeconds: draft.disappearDelaySeconds }
      : {}),
  }
  const pendingCount = Object.keys(patch).length

  const panelIcon = <Crosshair className="h-3.5 w-3.5 text-foreground-subtle" />

  if (isLoading && !status) {
    return (
      <WidgetPanel title={t('uiLibrary.autotrack.title', 'Autotrack')} icon={panelIcon}>
        <div className="flex items-center gap-2 text-[10.5px] text-foreground-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('uiLibrary.autotrack.loading', 'Loading autotrack…')}
        </div>
      </WidgetPanel>
    )
  }

  const toggleButton = (
    <button
      type="button"
      onClick={() => {
        void setEnabled(!(status?.enabled ?? false))
      }}
      disabled={isPending}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
        status?.enabled
          ? 'bg-success/15 text-success hover:bg-success/25'
          : 'bg-surface-elevated/40 text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
      } disabled:opacity-50`}
      aria-pressed={status?.enabled ?? false}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status?.enabled ? 'bg-success' : 'bg-foreground-subtle/40'
        }`}
      />
      {status?.enabled
        ? t('uiLibrary.autotrack.enabled', 'Enabled')
        : t('uiLibrary.autotrack.disabled', 'Disabled')}
    </button>
  )

  // WidgetPanel provides the canonical panel chrome (card frame, bordered
  // header with uppercase title + icon, padded body) so this widget matches
  // the visual language of all other cap-settings panels.
  return (
    <WidgetPanel
      title={t('uiLibrary.autotrack.title', 'Autotrack')}
      icon={panelIcon}
      headerRight={toggleButton}
      bodyClassName="p-3 space-y-2"
    >
      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[10px] text-danger">
          <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
          <span className="leading-snug break-words">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-2">
        {/* Target-type select rendered only when the camera advertised
            at least one supported value via the cap. */}
        {(status?.supportedTargetTypes?.length ?? 0) > 0 && (
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-[10px] font-medium text-foreground-subtle">
              {t('uiLibrary.autotrack.targetType', 'Target type')}
            </span>
            <Select
              value={draft.targetType}
              onChange={(e) => setDraft((d) => ({ ...d, targetType: e.target.value }))}
              disabled={isPending}
              className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
            >
              {(status?.supportedTargetTypes ?? []).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </label>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-foreground-subtle">
            {t('uiLibrary.autotrack.stopDelay', 'Stop delay (s)')}
          </span>
          <DurationInput
            value={draft.stopDelaySeconds}
            min={0}
            max={300}
            disabled={isPending}
            aria-label={t('uiLibrary.autotrack.stopDelay', 'Stop delay (s)')}
            onChange={(seconds) => setDraft((d) => ({ ...d, stopDelaySeconds: seconds }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-foreground-subtle">
            {t('uiLibrary.autotrack.disappearDelay', 'Disappear delay (s)')}
          </span>
          <DurationInput
            value={draft.disappearDelaySeconds}
            min={0}
            max={300}
            disabled={isPending}
            aria-label={t('uiLibrary.autotrack.disappearDelay', 'Disappear delay (s)')}
            onChange={(seconds) => setDraft((d) => ({ ...d, disappearDelaySeconds: seconds }))}
          />
        </div>
      </div>

      <p className="px-2 text-[9.5px] text-foreground-subtle leading-snug italic">
        {t(
          'uiLibrary.autotrack.note',
          'Vendor support varies — Reolink honours all three; Hikvision honours target type + stop delay only (disappear delay is accepted but ignored at firmware push).',
        )}
      </p>
      <FormSaveBar
        pendingCount={pendingCount}
        saving={isPending}
        onSave={() => void setSettings(patch)}
        onDiscard={() => {
          if (stored) setDraft({ ...stored })
        }}
      />
    </WidgetPanel>
  )
}

function sameSettings(a: PtzAutotrackSettings, b: PtzAutotrackSettings): boolean {
  return (
    a.targetType === b.targetType &&
    a.stopDelaySeconds === b.stopDelaySeconds &&
    a.disappearDelaySeconds === b.disappearDelaySeconds
  )
}
