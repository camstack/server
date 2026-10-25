import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { formatRelativeTime } from './format'
import type { HeroProps } from './HeroRegistry'
import { MotionTriggerToggle } from './MotionTriggerToggle'
import { useTranslation } from 'react-i18next'

/**
 * Light hero — on/off button + brightness slider.
 *
 * The on/off behaviour mirrors `SwitchHero` (every Light cap is paired
 * with `switch` on the same device — switch flips the relay, brightness
 * sets the level applied while on). Brightness is gated on `dev.brightness`
 * being present at runtime; a Light without a dimmer (some Reolink
 * floodlights) just shows the button.
 *
 * Slider commits on `pointerup` instead of every `input` event — Hikvision
 * and Reolink dim controls both rate-limit aggressively, so streaming
 * mutations on every drag tick would drop frames or be ignored. The
 * slice-driven readback handles UI freshness regardless.
 */
export function LightHero({ deviceId, deviceName }: HeroProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const switchSlice = useDeviceStateSlice(dev?.state.switch)
  const brightnessSlice = useDeviceStateSlice(dev?.state.brightness)

  const isOn = switchSlice?.on ?? false
  const lastChangedAt = switchSlice?.lastChangedAt ?? null
  const hasSwitch = switchSlice !== undefined
  const hasBrightness = brightnessSlice !== undefined
  const supportsBrightness = dev?.brightness !== undefined

  const [busy, setBusy] = useState(false)
  // Local slider value — mirrors the slice but allows uncommitted drag.
  // Synced from the slice whenever the firmware-reported level changes
  // so an external change (HomeKit, scene trigger) shows up immediately.
  const [sliderValue, setSliderValue] = useState<number>(brightnessSlice?.percentage ?? 0)
  useEffect(() => {
    if (brightnessSlice?.percentage !== undefined) setSliderValue(brightnessSlice.percentage)
  }, [brightnessSlice?.percentage])

  const handleToggle = async () => {
    // Wait for the slice to land before allowing a write — the cap
    // proxy is wired the moment the addon registers, but the worker
    // only accepts mutations after publishing the runtime state.
    // Without this gate, an early click sends a mutation that
    // fails with PRECONDITION_FAILED and gets retried on cap
    // registration — a stale operator click then turns the light
    // ON after a server restart even though they didn't intend to.
    // See #30.
    if (busy || !hasSwitch || !dev?.switch) return
    setBusy(true)
    try {
      await dev.switch.setState({ on: !isOn })
    } finally {
      setBusy(false)
    }
  }

  const handleCommitBrightness = async () => {
    if (busy || !hasBrightness || !dev?.brightness) return
    setBusy(true)
    try {
      await dev.brightness.setBrightness({ percentage: sliderValue })
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
        disabled={busy || !hasSwitch || !dev?.switch}
        title={
          !hasSwitch
            ? t('hero.lightHero.awaitingState', 'Awaiting state…')
            : isOn
              ? t('hero.lightHero.turnOff', 'Turn off {{deviceName}}', { deviceName })
              : t('hero.lightHero.turnOn', 'Turn on {{deviceName}}', { deviceName })
        }
        aria-pressed={isOn}
        className={`flex h-20 w-20 items-center justify-center rounded-full border-2 transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
          isOn
            ? 'border-warning bg-warning/20 text-warning shadow-lg shadow-warning/30'
            : 'border-border bg-surface text-foreground-subtle hover:border-foreground-subtle hover:text-foreground'
        }`}
      >
        <Lightbulb className="h-9 w-9" />
      </button>

      {supportsBrightness ? (
        <div className="flex w-full max-w-xs flex-col items-center gap-1">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sliderValue}
            disabled={busy || !isOn || !hasBrightness}
            onChange={(e) => setSliderValue(Number(e.currentTarget.value))}
            onPointerUp={() => {
              void handleCommitBrightness()
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter') void handleCommitBrightness()
            }}
            aria-label={t('hero.lightHero.brightness', 'Brightness')}
            className="w-full accent-warning disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="text-[10px] text-foreground-subtle tabular-nums">
            {hasBrightness
              ? `${String(sliderValue)}%`
              : t('hero.lightHero.brightnessUnavailable', 'Brightness unavailable')}
          </div>
        </div>
      ) : null}

      <MotionTriggerToggle dev={dev} busy={busy} setBusy={setBusy} />

      <div className="text-center">
        <div
          className={`text-sm font-semibold ${isOn ? 'text-warning' : 'text-foreground-subtle'}`}
        >
          {hasSwitch
            ? isOn
              ? t('hero.lightHero.on', 'On')
              : t('hero.lightHero.off', 'Off')
            : t('hero.lightHero.unknown', 'Unknown')}
        </div>
        <div className="text-[10px] text-foreground-subtle mt-0.5">
          {hasSwitch
            ? t('hero.lightHero.changed', 'Changed {{value1}}', {
                value1: formatRelativeTime(lastChangedAt),
              })
            : t('hero.lightHero.awaitingState', 'Awaiting state…')}
        </div>
      </div>
    </div>
  )
}
