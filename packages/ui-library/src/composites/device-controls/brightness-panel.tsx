import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import type { BrightnessStatus } from '@camstack/types'
import type { ControlPanelProps } from './types'

export function BrightnessPanel({
  trpc,
  deviceId,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    { setBrightness: (i: { percentage: number }) => Promise<void> },
    BrightnessStatus
  >({
    trpc,
    deviceId,
    cap: (d) =>
      d.brightness as { setBrightness: (i: { percentage: number }) => Promise<void> } | undefined,
    slice: (d) => d.state.brightness,
  })
  const { display, applyOptimistic } = useOptimisticSlice<BrightnessStatus>(slice, {
    enabled: optimistic ?? true,
  })
  if (display === undefined) return null
  const busy = !available
  return (
    <label
      className={cn(
        'flex items-center gap-2 text-xs text-foreground-subtle',
        layout === 'compact' && 'min-w-[140px]',
      )}
    >
      {/* No visible "Brightness" text label between the switch and the slider —
          the slider carries an aria-label for a11y. */}
      <input
        aria-label={t('uiLibrary.brightnessPanel.brightness', 'Brightness')}
        type="range"
        min={0}
        max={100}
        step={1}
        value={display.percentage}
        disabled={busy}
        onChange={(e) => {
          const pct = Number(e.target.value)
          applyOptimistic({ percentage: pct })
          if (!busy) void cap?.setBrightness({ percentage: pct })
        }}
      />
      <span className="tabular-nums w-8 text-right">{display.percentage}%</span>
    </label>
  )
}
