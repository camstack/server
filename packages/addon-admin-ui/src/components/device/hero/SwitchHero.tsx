import { useState } from 'react'
import { Power, Bell } from 'lucide-react'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { formatRelativeTime } from './format'
import type { HeroProps } from './HeroRegistry'
import { MotionTriggerToggle } from './MotionTriggerToggle'
import { useTranslation } from 'react-i18next'

/**
 * Switch / Siren hero — large on/off button driven by the `switch` cap.
 *
 * Reads `device.state.switch` for the current on/off state (mirrored
 * via the runtime-state slice — no polling) and writes via
 * `dev.switch.setState({ on })`. The slice push reaches us before the
 * mutation resolves, so the button reflects the new state immediately
 * without optimistic local state.
 *
 * `useSiren` swaps the icon to a bell (the Reolink + Hikvision siren
 * accessories are the only Switch-cap devices today that aren't a
 * floodlight/spotlight; the icon difference helps operators tell at a
 * glance which device they're looking at).
 */
export function SwitchHero({
  deviceId,
  deviceName,
  useSiren = false,
}: HeroProps & { useSiren?: boolean }) {
  const { t } = useTranslation()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const slice = useDeviceStateSlice(dev?.state.switch)
  const [busy, setBusy] = useState(false)

  const isOn = slice?.on ?? false
  const lastChangedAt = slice?.lastChangedAt ?? null
  const hasState = slice !== undefined
  const Icon = useSiren ? Bell : Power

  const handleToggle = async () => {
    // Guard on `hasState` (slice present), not just `dev?.switch`.
    // The cap proxy is wired the moment the addon is registered,
    // but the slice reaches us only after the addon's worker has
    // actually published the cap's runtime state. Clicking before
    // the slice arrives sends a mutation the worker rejects with
    // PRECONDITION_FAILED ("capability not registered for device
    // X"), which the UI silently retries — and lands a stale
    // operator click as soon as the cap registers (e.g. floodlight
    // jumping ON at server restart). See #30.
    if (busy || !hasState || !dev?.switch) return
    setBusy(true)
    try {
      await dev.switch.setState({ on: !isOn })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
      <button
        type="button"
        onClick={() => {
          void handleToggle()
        }}
        disabled={busy || !hasState || !dev?.switch}
        title={
          !hasState
            ? t('hero.switchHero.awaitingState', 'Awaiting state…')
            : isOn
              ? t('hero.switchHero.turnOff', 'Turn off {{deviceName}}', { deviceName })
              : t('hero.switchHero.turnOn', 'Turn on {{deviceName}}', { deviceName })
        }
        aria-pressed={isOn}
        className={`flex h-24 w-24 items-center justify-center rounded-full border-2 transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
          isOn
            ? 'border-success bg-success/20 text-success shadow-lg shadow-success/20'
            : 'border-border bg-surface text-foreground-subtle hover:border-foreground-subtle hover:text-foreground'
        }`}
      >
        <Icon className="h-10 w-10" />
      </button>
      <MotionTriggerToggle dev={dev} busy={busy} setBusy={setBusy} />

      <div className="text-center">
        <div
          className={`text-sm font-semibold ${isOn ? 'text-success' : 'text-foreground-subtle'}`}
        >
          {hasState
            ? isOn
              ? t('hero.switchHero.on', 'On')
              : t('hero.switchHero.off', 'Off')
            : t('hero.switchHero.unknown', 'Unknown')}
        </div>
        <div className="text-[10px] text-foreground-subtle mt-0.5">
          {hasState
            ? t('hero.switchHero.changed', 'Changed {{value1}}', {
                value1: formatRelativeTime(lastChangedAt),
              })
            : t('hero.switchHero.awaitingState', 'Awaiting state…')}
        </div>
      </div>
    </div>
  )
}
