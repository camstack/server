/**
 * Firmware/software Update controls for a `DeviceType.Update` device.
 *
 * Reads the `update` cap status slice (currentVersion / availableVersion /
 * updatable / state / inProgress) and renders:
 *   - InlineControl (device-list row): a compact state badge — "Update
 *     available" (actionable) / "Installing…" / current version (up to date).
 *   - HeroCard (device-detail hero): the version transition + an Install button
 *     that calls `update.installUpdate()` when an update is available.
 *
 * Mirrors the cover/sensor controls' `useDeviceCapability` pattern so the row
 * and the hero never diverge.
 */
import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { Download, Check, Loader2 } from 'lucide-react'
import type { UpdateStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { DeviceControlProps } from './control-registry'

/** The single mutation the `update` cap exposes. */
interface UpdateCap {
  readonly installUpdate: (input: Record<string, never>) => Promise<void>
}

/**
 * True when an update is actually AVAILABLE — i.e. the latest version differs
 * from the installed one. NOTE: the `updatable` flag means the device *supports*
 * firmware updates (a capability), NOT that one is pending — an up-to-date
 * device reports `updatable: true` with `availableVersion === currentVersion`.
 * Mirrors Home Assistant, which keys "update available" off installed≠latest.
 */
function hasUpdate(slice: UpdateStatus | undefined): boolean {
  if (slice === undefined || slice.inProgress) return false
  return (
    slice.availableVersion !== null &&
    slice.currentVersion !== null &&
    slice.availableVersion !== slice.currentVersion
  )
}

function useUpdate(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<UpdateCap, UpdateStatus>({
    trpc,
    deviceId,
    cap: (d) => d.update as UpdateCap | undefined,
    slice: (d) => d.state.update,
  })
}

/**
 * UpdateInlineControl — compact firmware state for a device-list row.
 */
export function UpdateInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice } = useUpdate(trpc, deviceId)
  if (cap === undefined) return null

  if (slice?.inProgress) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('uiLibrary.updateControl.updating', 'Updating…')}
      </span>
    )
  }

  if (hasUpdate(slice)) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
        <Download className="h-3 w-3" />
        {t('uiLibrary.updateControl.update', 'Update')}
      </span>
    )
  }

  // Up to date — show the current version when known, else a subtle check.
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-foreground-subtle">
      <Check className="h-3 w-3 text-success" />
      {slice?.currentVersion ?? t('uiLibrary.updateControl.upToDate', 'Up to date')}
    </span>
  )
}

/**
 * UpdateHeroCard — version transition + Install action for the device-detail
 * hero area.
 */
export function UpdateHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useUpdate(trpc, deviceId)
  if (cap === undefined) return null

  const inProgress = slice?.inProgress === true
  const updatable = hasUpdate(slice)
  const current = slice?.currentVersion ?? '—'

  const onInstall = (): void => {
    if (!available || cap === undefined || !updatable) return
    void cap.installUpdate({})
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tabular-nums text-foreground">{current}</span>
        {updatable && slice?.availableVersion != null && (
          <>
            <span className="text-base text-foreground-subtle">→</span>
            <span className="text-base font-medium text-warning tabular-nums">
              {slice.availableVersion}
            </span>
          </>
        )}
      </div>

      {inProgress ? (
        <span className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('uiLibrary.updateControl.installing', 'Installing…')}
        </span>
      ) : updatable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onInstall()
          }}
          disabled={!available}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" />
          {t('uiLibrary.updateControl.install', 'Install update')}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded bg-success/15 px-3 py-1 text-sm font-medium text-success">
          <Check className="h-4 w-4" />
          {t('uiLibrary.updateControl.upToDate', 'Up to date')}
        </span>
      )}

      {slice?.state != null && slice.state !== '' && (
        <span className="text-[10px] text-foreground-subtle">{slice.state}</span>
      )}
    </div>
  )
}
