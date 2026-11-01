/**
 * "Run for N" - the inline control of the `timed-run` cap (D993).
 *
 * A number, the unit it is in, and a Run button: the hub turns the device on and
 * switches it off again after that long. While a run is armed the control shows
 * the time left (counted down from the slice's `activeUntil`) and a Cancel. The
 * maximum is the device type's own bound (`TIMED_RUN_LIMITS`); a value above it
 * is refused by the hub with a typed reason, which this control says in words.
 *
 * Rendered only when the device binds `timed-run`. An unknown slice is "nothing
 * armed", never a running timer.
 */
import { Timer, TimerOff } from 'lucide-react'
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
const DEFAULT_MINUTES = 30
const DEFAULT_SECONDS = 60

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
  const [draft, setDraft] = useState<number>(
    Math.min(max, limit.unit === 'min' ? DEFAULT_MINUTES : DEFAULT_SECONDS),
  )
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
          onChange={(event) => setDraft(event.target.valueAsNumber)}
        />
        <span className="text-xs text-foreground-muted">{unitLabel}</span>
        <Button size="sm" disabled={!online || !valid} onClick={run}>
          <Timer className="h-4 w-4" aria-hidden />
          {t('uiLibrary.timedRun.run', 'Run')}
        </Button>
        {armed && (
          <>
            <span
              className="text-xs font-medium tabular-nums text-foreground"
              data-testid="timed-run-countdown"
            >
              {t('uiLibrary.timedRun.remaining', '{{time}} left', {
                time: formatCountdown(activeUntil - now),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!online}
              aria-label={t('uiLibrary.timedRun.cancel', 'Cancel the timer')}
              onClick={() => void cap.cancel({})}
            >
              <TimerOff className="h-4 w-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
      {!valid && (
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
