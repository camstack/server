import { useState } from 'react'
import { Activity } from 'lucide-react'
import { useDeviceStateSlice, Button } from '@camstack/ui-library'
import type { DeviceProxy } from '@camstack/types'
import { useTranslation } from 'react-i18next'

/**
 * Small "Trigger on motion" toggle rendered inside the Light + Switch
 * (Siren) heroes when the device exposes the `motion-trigger` cap.
 *
 * Reads the current state via `device.state.motionTrigger` (runtime-state
 * slice — pushed reactively by the provider on every set + 30s poll).
 * Writes via `setMotionTrigger` on click.
 *
 * The button waits for the slice to land before enabling clicks — a cap
 * proxy is wired the moment the addon registers, but the provider's
 * worker only accepts mutations after publishing the runtime state.
 * Clicking before the slice arrives sends a mutation the worker rejects
 * with PRECONDITION_FAILED ("capability not registered for device X"),
 * which the UI silently retries — and lands a stale operator click as
 * soon as the cap registers. That's how Reolink floodlights ended up
 * armed-on-motion at every server restart even though nobody touched
 * the toggle. See #30.
 *
 * Renders nothing when the cap isn't present on the device — the
 * Floodlight / Siren accessory only registers `motion-trigger` when the
 * driver knows the firmware supports it.
 */
export function MotionTriggerToggle({
  dev,
  busy,
  setBusy,
}: {
  dev: DeviceProxy | null
  busy: boolean
  setBusy: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const motionTrigger = dev?.motionTrigger
  const slice = useDeviceStateSlice(dev?.state.motionTrigger)
  const [pendingClick, setPendingClick] = useState(false)

  if (!motionTrigger) return null

  const isOn = slice?.enabled === true
  const hasState = slice !== undefined

  const handleToggle = async () => {
    if (busy || !hasState) return
    const next = !isOn
    setBusy(true)
    setPendingClick(true)
    try {
      await motionTrigger.setMotionTrigger({ enabled: next })
      // Provider writes the slice on success → useSyncExternalStore
      // re-renders with the fresh value before this returns.
    } finally {
      setBusy(false)
      setPendingClick(false)
    }
  }

  const label = pendingClick
    ? isOn
      ? 'Disabling…'
      : 'Enabling…'
    : hasState
      ? isOn
        ? 'On motion: on'
        : 'On motion: off'
      : 'On motion: …'

  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={() => {
        void handleToggle()
      }}
      disabled={busy || !hasState}
      title={
        !hasState
          ? t('hero.motionTriggerToggle.awaitingState', 'Awaiting state…')
          : isOn
            ? t('hero.motionTriggerToggle.disableTriggerOnMotion', 'Disable trigger on motion')
            : t('hero.motionTriggerToggle.enableTriggerOnMotion', 'Enable trigger on motion')
      }
      aria-pressed={isOn}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        isOn
          ? 'border-primary/50 bg-primary/15 text-primary'
          : 'border-border bg-surface text-foreground-subtle hover:text-foreground'
      }`}
    >
      <Activity className="h-3 w-3" />
      <span>{label}</span>
    </Button>
  )
}
