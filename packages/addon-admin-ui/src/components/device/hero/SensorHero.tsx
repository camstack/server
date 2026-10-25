import { Activity, Radar } from 'lucide-react'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { formatRelativeTime } from './format'
import type { HeroProps } from './HeroRegistry'
import { useTranslation } from 'react-i18next'

/**
 * Sensor hero — motion / contact / PIR readout. Reads the `motion` cap
 * runtime-state slice (push-driven) so the indicator flips the instant
 * the firmware sends a transition. No method calls: sensors are read-only.
 *
 * Renders as a colour-coded badge ("Triggered" red, "Idle" muted) with
 * the last-trip timestamp. Falls back to the generic identity card when
 * the device exposes no `motion` slice (rare — a sensor without a motion
 * surface is currently a misconfiguration; keep the hero defensive).
 */
export function SensorHero({ deviceId }: HeroProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const slice = useDeviceStateSlice(dev?.state.motion)

  const detected = slice?.detected ?? false
  const lastDetectedAt = slice?.lastDetectedAt ?? null
  const hasState = slice !== undefined

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
      <div
        className={`flex h-24 w-24 items-center justify-center rounded-full border-2 transition-all ${
          detected
            ? 'border-danger bg-danger/20 text-danger shadow-lg shadow-danger/30 animate-pulse'
            : 'border-border bg-surface text-foreground-subtle'
        }`}
        aria-live="polite"
        title={
          detected
            ? t('hero.sensorHero.motionDetected', 'Motion detected')
            : t('hero.sensorHero.idle', 'Idle')
        }
      >
        {detected ? <Radar className="h-10 w-10" /> : <Activity className="h-10 w-10" />}
      </div>
      <div className="text-center">
        <div
          className={`text-sm font-semibold ${detected ? 'text-danger' : 'text-foreground-subtle'}`}
        >
          {hasState
            ? detected
              ? t('hero.sensorHero.triggered', 'Triggered')
              : t('hero.sensorHero.idle', 'Idle')
            : t('hero.sensorHero.unknown', 'Unknown')}
        </div>
        <div className="text-[10px] text-foreground-subtle mt-0.5">
          {hasState
            ? t('hero.sensorHero.lastTrip', 'Last trip {{value1}}', {
                value1: formatRelativeTime(lastDetectedAt),
              })
            : t('hero.sensorHero.awaitingState', 'Awaiting state…')}
        </div>
      </div>
    </div>
  )
}
