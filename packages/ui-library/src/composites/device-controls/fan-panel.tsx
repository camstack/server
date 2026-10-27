import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { FanControlStatus } from '@camstack/types'
import type { ControlPanelProps } from './types'

export function FanPanel({
  trpc,
  deviceId,
  features,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    {
      setPercentage: (i: { speed: number }) => Promise<void>
      setPreset: (i: { preset: string }) => Promise<void>
    },
    FanControlStatus
  >({
    trpc,
    deviceId,
    cap: (d) =>
      d.fanControl as
        | {
            setPercentage: (i: { speed: number }) => Promise<void>
            setPreset: (i: { preset: string }) => Promise<void>
          }
        | undefined,
    slice: (d) => d.state.fanControl,
  })
  const { display, applyOptimistic } = useOptimisticSlice<FanControlStatus>(slice, {
    enabled: optimistic ?? true,
  })
  if (display === undefined) return null
  const busy = !available
  const feats = features ?? []
  const showSpeed = feats.includes('fan-speed')
  const showPreset = feats.includes('fan-preset')
  const step = slice?.percentageStep != null && slice.percentageStep > 0 ? slice.percentageStep : 1
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2',
        layout === 'full' && 'flex-col items-stretch',
      )}
    >
      {showSpeed && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <input
            aria-label={t('uiLibrary.fanPanel.speed', 'Fan speed')}
            type="range"
            min={0}
            max={100}
            step={step}
            value={display.speed ?? 0}
            disabled={busy}
            onChange={(e) => {
              const raw = Number(e.target.value)
              const pct = Math.min(100, Math.max(0, Math.round(raw / step) * step))
              applyOptimistic({ speed: pct })
              if (!busy) void cap?.setPercentage({ speed: pct })
            }}
          />
          <span className="tabular-nums w-8 text-right">{display.speed ?? '—'}%</span>
        </div>
      )}
      {showPreset && display.availablePresets.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <select
            aria-label={t('uiLibrary.fanPanel.preset', 'Fan preset')}
            value={display.preset}
            disabled={busy}
            onChange={(e) => {
              const preset = e.target.value
              if (!busy && preset) {
                applyOptimistic({ preset })
                void cap?.setPreset({ preset })
              }
            }}
            className="bg-surface border border-border rounded px-1 py-0.5"
          >
            <option value="" disabled>
              —
            </option>
            {display.availablePresets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
