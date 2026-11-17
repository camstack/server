/**
 * A one-shot command (Feed, Run): a second tap while the first is still in
 * flight must not send it twice (D1061).
 *
 * The server holds the command's effect (`feeding`, `isRunning`) once the
 * command reaches it, and the control then reads that from the slice. Between
 * the tap and that slice there is a window where the served state still says
 * "idle" — a double tap lands in it. This hook closes the window on the
 * client: `claim` marks the command in flight SYNCHRONOUSLY (a ref, so a
 * second tap in the same tick already sees it) and releases it when the
 * command settles, by which time the held slice has taken over.
 *
 * It decides nothing about what the control shows: the button is disabled
 * while `inFlight`, and the served slice stays the only state.
 */
import { useCallback, useRef, useState } from 'react'

/** A command thunk, as `useDeviceCommand` and `reportedCommand` take it. */
export type OneShotThunk = () => PromiseLike<unknown> | undefined

export interface OneShotCommand {
  /** True from the tap until the command settles. */
  readonly inFlight: boolean
  /**
   * `command`, wrapped to stay in flight until it settles — or `null` when a
   * command is already in flight (the second tap of a double tap), in which
   * case the caller sends nothing.
   */
  readonly claim: (command: OneShotThunk) => OneShotThunk | null
}

export function useOneShotCommand(): OneShotCommand {
  const flying = useRef(false)
  const [inFlight, setInFlight] = useState(false)

  const release = useCallback((): void => {
    flying.current = false
    setInFlight(false)
  }, [])

  const claim = useCallback(
    (command: OneShotThunk): OneShotThunk | null => {
      if (flying.current) return null
      flying.current = true
      setInFlight(true)
      return () => {
        let pending: PromiseLike<unknown> | undefined
        try {
          pending = command()
        } catch (err) {
          release()
          throw err
        }
        if (pending === undefined) {
          release()
          return undefined
        }
        return Promise.resolve(pending).finally(release)
      }
    },
    [release],
  )

  return { inFlight, claim }
}
