/**
 * The list-row timed run (D993): Run beside the power control while idle,
 * Stop and the time left while a run is armed. Drawn only when the device
 * binds `timed-run`. The words and the bound come from the same limit the
 * row projection uses.
 */
import { Square, Timer } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { timedRunLimitOf, timedRunRemaining, type TimedRunUnit } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { Button } from '../../primitives/button'

const TICK_MS = 1000

export interface TimedRunRowControlProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly deviceType: string
  /** With the type, which device this is: a switch has a timed run only as a heater (D1033). */
  readonly deviceRole: string | null
}

function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const handle = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(handle)
  }, [active])
  return now
}

export function TimedRunRowControl({
  trpc,
  deviceId,
  deviceType,
  deviceRole,
}: TimedRunRowControlProps): ReactNode {
  const t = useUiText()
  const limit = timedRunLimitOf(deviceType, deviceRole)
  const { cap, slice, online } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.timedRun,
    slice: (d) => d.state.timedRun,
  })
  const activeUntil = slice?.activeUntil ?? null
  const now = useNow(limit !== null && cap !== undefined && activeUntil !== null)
  if (limit === null || cap === undefined) return null

  const duration = slice?.quickRun?.duration ?? limit.quickRunDefault
  const unit: TimedRunUnit = limit.unit
  const unitLabel =
    unit === 'min' ? t('uiLibrary.timedRun.minutes', 'min') : t('uiLibrary.timedRun.seconds', 's')
  const armed = activeUntil !== null && activeUntil > now

  if (armed && activeUntil !== null) {
    const left = timedRunRemaining(activeUntil, now, unit)
    return (
      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="outline" disabled={!online} onClick={() => void cap.cancel({})}>
          <Square className="h-3.5 w-3.5" aria-hidden />
          {t('uiLibrary.timedRun.stop', 'Stop')}
        </Button>
        <span className="text-sm tabular-nums text-foreground">
          {t('uiLibrary.timedRun.remaining', '{{time}} left', {
            time: `${left} ${unitLabel}`,
          })}
        </span>
      </span>
    )
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Button
        size="sm"
        variant="outline"
        disabled={!online}
        onClick={() => void cap.runFor({ duration, unit })}
      >
        <Timer className="h-3.5 w-3.5" aria-hidden />
        {t('uiLibrary.timedRun.quickRun', 'Run {{duration}} {{unit}}', {
          duration,
          unit: unitLabel,
        })}
      </Button>
    </span>
  )
}
