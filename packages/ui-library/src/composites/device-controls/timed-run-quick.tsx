/**
 * The compact timed run (D993) every surface draws: `⏱ 15 min ▶` while idle, `■ 12 min left`
 * while armed. The number is editable in place and is saved once, after the last keystroke
 * (`QUICK_RUN_SAVE_DEBOUNCE_MS`); ▶ runs the value the field holds. A refused save or run
 * (above the maximum, the device offline) is said under the control, never swallowed.
 *
 * It never wraps and never shrinks: whatever sits beside it (a slider, a name) gives up the
 * space, and the host moves the whole block to its own line when the width runs out.
 */
import { Play, Square, Timer } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { timedRunRemaining, type TimedRunResult } from '@dominevo/types'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { DurationInput } from '../duration-input/DurationInput'
import {
  isValidQuickRun,
  QUICK_RUN_SAVE_DEBOUNCE_MS,
  quickRunRefusalKey,
  type TimedRunQuickCalls,
  type TimedRunQuickView,
} from './timed-run-quick-model'

const TICK_MS = 1000
const REFUSAL_FALLBACK: Readonly<Record<string, string>> = {
  'uiLibrary.timedRun.overMax': 'That is longer than this device may run.',
  'uiLibrary.timedRun.commandFailed': 'The device did not turn on.',
  'uiLibrary.timedRun.unsupported': 'This device cannot run on a timer.',
}

export interface TimedRunQuickProps extends TimedRunQuickView, TimedRunQuickCalls {
  /** False while the device is offline: the control is drawn, not usable. */
  readonly online?: boolean
  /** A surface that blocks actuation (a card without the grant). */
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly className?: string
  readonly testIdPrefix?: string
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TimedRunQuick({
  unit,
  saved,
  max,
  activeUntil,
  save,
  run,
  stop,
  online = true,
  disabled = false,
  disabledReason,
  className,
  testIdPrefix = 'timed-run',
}: TimedRunQuickProps): ReactNode {
  const t = useUiText()
  const [edited, setEdited] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save
  const shown = edited ?? saved
  const now = useNow(activeUntil !== null)
  const armed = activeUntil !== null && activeUntil > now
  const blocked = disabled || !online
  const unitLabel =
    unit === 'min' ? t('uiLibrary.timedRun.minutes', 'min') : t('uiLibrary.timedRun.seconds', 's')

  // The saved value reached the slice: the field is the server's again.
  useEffect(() => {
    if (edited !== null && edited === saved) setEdited(null)
  }, [edited, saved])

  const commit = (duration: number): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
    saveRef.current(duration).catch((e: unknown) => {
      setError(
        t('uiLibrary.timedRun.saveFailed', 'Could not save: {{reason}}', { reason: reasonOf(e) }),
      )
    })
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  // Leaving with an edit not yet saved saves it: a change is never dropped silently.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (pendingRef.current !== null) commitRef.current(pendingRef.current)
    },
    [],
  )

  const rangeError = (): string =>
    t('uiLibrary.timedRun.range', 'Enter 1 to {{max}} {{unit}}', { max, unit: unitLabel })

  const onChange = (duration: number): void => {
    setEdited(duration)
    if (!isValidQuickRun(duration, max)) {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      pendingRef.current = null
      setError(rangeError())
      return
    }
    setError(null)
    pendingRef.current = duration
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(duration), QUICK_RUN_SAVE_DEBOUNCE_MS)
  }

  const onRun = (): void => {
    if (!isValidQuickRun(shown, max)) {
      setError(rangeError())
      return
    }
    setError(null)
    if (pendingRef.current !== null) commit(pendingRef.current)
    void Promise.resolve(run(shown)).then(
      (result: TimedRunResult | undefined) => {
        if (result !== undefined && !result.ok) {
          const key = quickRunRefusalKey(result.reason)
          setError(t(key, REFUSAL_FALLBACK[key] ?? key))
        }
      },
      (e: unknown) => setError(reasonOf(e)),
    )
  }

  const onStop = (): void => {
    setError(null)
    void Promise.resolve(stop()).catch((e: unknown) => setError(reasonOf(e)))
  }

  const timeLeft = (): string =>
    t('uiLibrary.timedRun.remaining', '{{time}} left', {
      time: `${timedRunRemaining(activeUntil ?? now, now, unit)} ${unitLabel}`,
    })

  return (
    <span
      className={cn('inline-flex shrink-0 flex-col items-end gap-0.5 whitespace-nowrap', className)}
      data-testid={testIdPrefix}
      onClick={(e) => e.stopPropagation()}
    >
      {armed ? (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0 whitespace-nowrap tabular-nums"
          disabled={blocked}
          title={disabled ? disabledReason : undefined}
          aria-label={t('uiLibrary.timedRun.stopAria', 'Stop the timed run, {{left}}', {
            left: timeLeft(),
          })}
          data-testid={`${testIdPrefix}-stop`}
          onClick={onStop}
        >
          <Square className="h-3 w-3 shrink-0" aria-hidden />
          {timeLeft()}
        </Button>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Timer className="h-3.5 w-3.5 shrink-0 text-foreground-muted" aria-hidden />
          <DurationInput
            value={shown}
            storageUnit={unit}
            units={[unit === 'min' ? 'minutes' : 'seconds']}
            min={1}
            max={max}
            disabled={blocked}
            className="shrink-0"
            aria-label={t('uiLibrary.timedRun.duration', 'Run for')}
            testIdPrefix={`${testIdPrefix}-duration`}
            onChange={onChange}
          />
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={blocked}
            title={disabled ? disabledReason : undefined}
            aria-label={t('uiLibrary.timedRun.runAria', 'Run for {{duration}} {{unit}}', {
              duration: shown,
              unit: unitLabel,
            })}
            data-testid={`${testIdPrefix}-run`}
            onClick={onRun}
          >
            <Play className="h-3 w-3 shrink-0" aria-hidden />
          </Button>
        </span>
      )}
      {error !== null && (
        <span className="whitespace-normal text-right text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
