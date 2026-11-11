/**
 * "Run for N" - the inline control of the `timed-run` cap (D993).
 *
 * A number, the unit it is in, and a Run button: the hub turns the device on and
 * switches it off again after that long. While a run is armed the control shows
 * Stop, the time left (counted down from the slice's `activeUntil`) and Restart
 * replace the start field. Restart runs again for the duration the field holds (the
 * device's one-tap run unless edited); the slice does not carry the running duration. The
 * maximum is the device type's own bound (`timedRunLimitOf`, by type and role); a value above it
 * is refused by the hub with a typed reason, which this control says in words.
 *
 * Rendered only when the device binds `timed-run`. An unknown slice is "nothing
 * armed", never a running timer.
 */
import { RotateCw, Square, Timer } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { TimedRunLimit, TimedRunRefusal } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { Button } from '../../primitives/button'
import { Input } from '../../primitives/input'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'

const TICK_MS = 1000
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000

export interface TimedRunControlProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly limit: TimedRunLimit
}

/** `m:ss` for a countdown; a started run never shows a negative time. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND))
  const minutes = Math.floor(total / SECONDS_PER_MINUTE)
  const seconds = total % SECONDS_PER_MINUTE
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The largest value the field accepts, in the limit's unit. */
export function maxInUnit(limit: TimedRunLimit): number {
  return limit.unit === 'min' ? limit.maxSeconds / SECONDS_PER_MINUTE : limit.maxSeconds
}

function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const handle = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(handle)
  }, [active])
  return now
}

export function TimedRunControl({ trpc, deviceId, limit }: TimedRunControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, online } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.timedRun,
    slice: (d) => d.state.timedRun,
  })
  const max = maxInUnit(limit)
  // What the operator typed, else this device's own one-tap run (the status), else the type's.
  const [edited, setEdited] = useState<number | null>(null)
  const draft = edited ?? Math.min(max, slice?.quickRun?.duration ?? limit.quickRunDefault)
  const [refusal, setRefusal] = useState<TimedRunRefusal | null>(null)
  const activeUntil = slice?.activeUntil ?? null
  const now = useNow(activeUntil !== null)

  if (cap === undefined) return null

  const unitLabel =
    limit.unit === 'min'
      ? t('uiLibrary.timedRun.minutes', 'min')
      : t('uiLibrary.timedRun.seconds', 's')
  const valid = Number.isFinite(draft) && draft > 0 && draft <= max
  const armed = activeUntil !== null && activeUntil > now

  const run = (): void => {
    if (!valid) return
    setRefusal(null)
    void cap.runFor({ duration: draft, unit: limit.unit }).then((result) => {
      if (!result.ok) setRefusal(result.reason)
    })
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="timed-run-control">
      {armed ? (
        <div
          className="flex items-center justify-between gap-2"
          role="group"
          aria-label={t('uiLibrary.timedRun.running', 'Timed run')}
          data-testid="timed-run-armed"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!online}
            onClick={() => void cap.cancel({})}
          >
            <Square className="h-4 w-4" aria-hidden />
            {t('uiLibrary.timedRun.stop', 'Stop')}
          </Button>
          <span
            className="text-sm font-medium tabular-nums text-foreground"
            data-testid="timed-run-countdown"
          >
            {t('uiLibrary.timedRun.remaining', '{{time}} left', {
              time: formatCountdown(activeUntil - now),
            })}
          </span>
          <Button size="sm" disabled={!online || !valid} onClick={run}>
            <RotateCw className="h-4 w-4" aria-hidden />
            {t('uiLibrary.timedRun.restart', 'Restart')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step={1}
            value={Number.isFinite(draft) ? draft : ''}
            disabled={!online}
            aria-label={t('uiLibrary.timedRun.duration', 'Run for')}
            className="w-20 tabular-nums"
            onChange={(event) => setEdited(event.target.valueAsNumber)}
          />
          <span className="text-xs text-foreground-muted">{unitLabel}</span>
          <Button size="sm" disabled={!online || !valid} onClick={run}>
            <Timer className="h-4 w-4" aria-hidden />
            {t('uiLibrary.timedRun.run', 'Run')}
          </Button>
        </div>
      )}
      {!armed && !valid && (
        <span className="text-xs text-danger">
          {t('uiLibrary.timedRun.range', 'Enter 1 to {{max}} {{unit}}', { max, unit: unitLabel })}
        </span>
      )}
      {refusal !== null && (
        <span className="text-xs text-danger" role="alert">
          {refusal === 'over-max'
            ? t('uiLibrary.timedRun.overMax', 'That is longer than this device may run.')
            : refusal === 'command-failed'
              ? t('uiLibrary.timedRun.commandFailed', 'The device did not turn on.')
              : t('uiLibrary.timedRun.unsupported', 'This device cannot run on a timer.')}
        </span>
      )}
    </div>
  )
}
