import { Slider } from '../../primitives/slider'
import { Select } from '../../primitives/select'
import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useDeviceCommand } from '../../hooks/use-device-command'
import { useDragValue } from '../../hooks/use-drag-value'
import { cn } from '../../lib/cn'
import type { FanControlStatus } from '@camstack/types'
import type { ControlPanelProps } from './types'

export function FanPanel({ trpc, deviceId, features, layout }: ControlPanelProps): ReactNode {
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
  const display = slice
  const runCommand = useDeviceCommand()
  const busy = !available
  const step = slice?.percentageStep != null && slice.percentageStep > 0 ? slice.percentageStep : 1
  const speed = useDragValue({
    served: display?.speed ?? 0,
    onCommit: (raw) => {
      const pct = Math.min(100, Math.max(0, Math.round(raw / step) * step))
      if (!busy) runCommand(() => cap?.setPercentage({ speed: pct }))
    },
  })
  if (display === undefined) return null
  const feats = features ?? []
  const showSpeed = feats.includes('fan-speed')
  const showPreset = feats.includes('fan-preset')
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2',
        layout === 'full' && 'flex-col items-stretch',
      )}
    >
      {showSpeed && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Slider
            aria-label={t('uiLibrary.fanPanel.speed', 'Fan speed')}
            min={0}
            max={100}
            step={step}
            disabled={busy}
            {...speed.sliderProps}
          />
          <span className="tabular-nums w-8 text-right">
            {display.speed === null && speed.shown === 0 ? '—' : speed.shown}%
          </span>
        </div>
      )}
      {showPreset && display.availablePresets.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Select
            aria-label={t('uiLibrary.fanPanel.preset', 'Fan preset')}
            value={display.preset}
            disabled={busy}
            onChange={(e) => {
              const preset = e.target.value
              if (!busy && preset) {
                runCommand(() => cap?.setPreset({ preset }))
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
          </Select>
        </div>
      )}
    </div>
  )
}
