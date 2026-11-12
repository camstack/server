import { useCallback, useMemo, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'

/** Applies a patch optimistically, runs the command, and reports a refusal. */
export type OptimisticApply<T> = (
  patch: Partial<T>,
  run: () => PromiseLike<unknown> | undefined,
  onError?: (error: unknown) => void,
) => void

export interface CommandNotice {
  /** Why the last command failed, for the card's reason line; null when it went through. */
  readonly notice: string | null
  readonly fail: (error: unknown) => void
  readonly succeed: () => void
}

/** The card's one place for "the last command failed, and why". */
export function useCommandNotice(): CommandNotice {
  const t = useUiText()
  const [notice, setNotice] = useState<string | null>(null)
  const fail = useCallback(
    (error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error)
      setNotice(t('uiLibrary.deviceCard.commandFailed', 'Command failed: {{reason}}', { reason }))
    },
    [t],
  )
  const succeed = useCallback((): void => setNotice(null), [])
  return useMemo(() => ({ notice, fail, succeed }), [notice, fail, succeed])
}

/**
 * An optimistic command whose outcome lands on the card: a refusal puts its
 * reason on the reason line, the next success clears it.
 */
export function reportedCommand<T>(
  apply: OptimisticApply<T>,
  report: Pick<CommandNotice, 'fail' | 'succeed'>,
): (patch: Partial<T>, run: () => PromiseLike<unknown> | undefined) => void {
  return (patch, run) =>
    apply(
      patch,
      () =>
        Promise.resolve(run()).then((result) => {
          report.succeed()
          return result
        }),
      report.fail,
    )
}

/**
 * The binding does not offer this method. A call that skipped it used to
 * resolve as a success (`fn?.()` is `undefined`, and a resolved `undefined`
 * is not a refusal). Callers report this instead.
 */
export class MissingCommandError extends Error {
  readonly cap: string
  readonly method: string

  constructor(cap: string, method: string) {
    super(`${cap} does not implement ${method}`)
    this.name = 'MissingCommandError'
    this.cap = cap
    this.method = method
  }
}

/**
 * The method when the device implements it; a rejection naming the cap and
 * the method when it does not. Never a resolved `undefined`.
 */
export function presentCommand<I, R>(
  fn: ((input: I) => PromiseLike<R>) | undefined,
  cap: string,
  method: string,
): (input: I) => Promise<R> {
  return (input) => {
    if (fn === undefined) return Promise.reject(new MissingCommandError(cap, method))
    return Promise.resolve(fn(input))
  }
}

/**
 * A plain command whose outcome lands on the card, for a field the card shows
 * as reported (no optimistic patch): a refusal names its reason, a success
 * clears it. The promise tells the caller whether it went through (true) or
 * failed (false); it never rejects.
 */
export function reportedCall(
  report: Pick<CommandNotice, 'fail' | 'succeed'>,
): (run: () => PromiseLike<unknown> | undefined) => Promise<boolean> {
  return (run) =>
    Promise.resolve()
      .then(run)
      .then(
        () => {
          report.succeed()
          return true
        },
        (error: unknown) => {
          report.fail(error)
          return false
        },
      )
}
