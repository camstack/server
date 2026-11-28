import { Slider } from '../../primitives/slider'
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useDeviceCommand } from '../../hooks/use-device-command'
import { useDragValue } from '../../hooks/use-drag-value'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import type { BrightnessStatus } from '@dominevo/types'
import type { ControlPanelProps } from './types'

export function BrightnessPanel({ trpc, deviceId, layout }: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    { setBrightness: (i: { level: number }) => Promise<void> },
    BrightnessStatus
  >({
    trpc,
    deviceId,
    cap: (d) =>
      d.brightness as { setBrightness: (i: { level: number }) => Promise<void> } | undefined,
    slice: (d) => d.state.brightness,
  })
  const display = slice
  const runCommand = useDeviceCommand()
  const busy = !available
  const level = useDragValue({
    served: display?.level ?? 0,
    onCommit: (pct) => {
      if (!busy) runCommand(() => cap?.setBrightness({ level: pct }))
    },
  })
  if (display === undefined) return null
  return (
    <label
      className={cn(
        'flex items-center gap-2 text-xs text-foreground-subtle',
        layout === 'compact' && 'min-w-[140px]',
      )}
    >
      {/* No visible "Brightness" text label between the switch and the slider —
          the slider carries an aria-label for a11y. */}
      <Slider
        aria-label={t('uiLibrary.brightnessPanel.brightness', 'Brightness')}
        min={0}
        max={100}
        step={1}
        disabled={busy}
        {...level.sliderProps}
      />
      <span className="tabular-nums w-8 text-right">{level.shown}%</span>
    </label>
  )
}
