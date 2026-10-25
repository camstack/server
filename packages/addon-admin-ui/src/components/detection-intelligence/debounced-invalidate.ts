/**
 * createDebouncedInvalidate — pure, timer-injectable trailing-edge
 * coalescer for the face-gallery live-refresh hook.
 *
 * NOT a reset-per-call debounce (that would let a steady drip of events
 * push the invalidation out forever). Instead it's a fixed WINDOW: the
 * first `trigger()` opens a `delayMs` window and schedules exactly one
 * `invalidate()` at its close; every `trigger()` call that lands while a
 * window is already open is coalesced (absorbed, doesn't extend the
 * deadline). Once the window closes and fires, the next `trigger()` opens
 * a fresh window.
 *
 * This is what collapses a burst of N `face-gallery-changed` events (e.g.
 * the two fired per delete-of-assigned-face: unassigned + deleted) into a
 * single React Query invalidation ~delayMs after the first event in the
 * burst, without starving a UI under sustained event traffic.
 */

export interface DebouncedInvalidateOptions {
  /** Window length in ms — time from the first coalesced trigger to the invalidate. */
  readonly delayMs: number
  /** Called once when the window closes. */
  readonly invalidate: () => void
  /** Injectable timer functions — default to the global ones. Lets callers
   *  swap in a fake scheduler without vitest's global timer mocking. */
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
}

export interface DebouncedInvalidate {
  /** Register an event. Opens a new window if none is pending; otherwise coalesced. */
  readonly trigger: () => void
  /** Cancel a pending window so it never fires (e.g. on unmount). No-op if none is pending. */
  readonly cancel: () => void
}

export function createDebouncedInvalidate(
  options: DebouncedInvalidateOptions,
): DebouncedInvalidate {
  const { delayMs, invalidate, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = options

  let pending: ReturnType<typeof setTimeout> | undefined

  function trigger(): void {
    if (pending !== undefined) return // window already open — coalesce
    pending = setTimeoutFn(() => {
      pending = undefined
      invalidate()
    }, delayMs)
  }

  function cancel(): void {
    if (pending === undefined) return
    clearTimeoutFn(pending)
    pending = undefined
  }

  return { trigger, cancel }
}
