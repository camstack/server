/**
 * useOptimisticSlice — generic optimistic-UI helper for device-control panels.
 *
 * When the operator triggers a control action (toggle, open, setTarget…) the UI
 * should reflect the expected resulting state IMMEDIATELY instead of waiting for
 * the server state-push round-trip (typically 300ms–2s over WebSocket).
 *
 * Usage pattern:
 *   const { cap, slice } = useDeviceCapability(…)
 *   const { display, applyOptimistic } = useOptimisticSlice(slice)
 *   // Render from `display` instead of `slice`.
 *   // After calling a cap mutation, call applyOptimistic({ field: expectedValue }).
 *
 * Reconciliation — the override is cleared when:
 *   (a) The real slice advances: detected by a change in `slice.lastChangedAt` if
 *       the field is present, OR a new object reference after the override was set.
 *   (b) A safety-net timeout (`timeoutMs`, default 4000ms) elapses without a push,
 *       so stale optimistic state is never stuck indefinitely. For a command run
 *       through `applyOptimisticAction` the net only starts once the command has
 *       SETTLED: a slow device never loses the new value while its answer is
 *       still pending, and a refused command rolls back at once.
 *
 * With `enabled: false` the hook is a passthrough: `display === realSlice` and
 * `applyOptimistic` is a no-op.
 */
import { useState, useRef, useEffect, useCallback } from 'react'

export interface UseOptimisticSliceOptions {
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

export interface UseOptimisticSliceResult<T> {
  /** The slice to RENDER: the optimistic override if active, else the real slice. */
  readonly display: T | undefined
  /** Apply an optimistic patch (merged onto the current display) after issuing a command. */
  readonly applyOptimistic: (patch: Partial<T>) => void
  /**
   * Revert immediately to the real slice — a real rollback, not a timer wait.
   * Use this when the command the optimistic patch anticipated is REJECTED
   * (the server refused it), so `display` never keeps showing a state the
   * server never produced.
   */
  readonly rollback: () => void
  /**
   * Apply `patch` and run the command it anticipates. A command that throws or
   * rejects rolls the display back to the real slice and reports the error to
   * `onError` (when given); one that succeeds keeps the new value until the real
   * slice agrees (or the safety net elapses). Prefer this to a bare
   * `applyOptimistic` followed by a discarded `void cap.x()`.
   */
  readonly applyOptimisticAction: (
    patch: Partial<T>,
    run: () => PromiseLike<unknown> | undefined,
    onError?: (error: unknown) => void,
  ) => void
}

const DEFAULT_TIMEOUT_MS = 4000

/**
 * Extract a reconciliation "version" from a slice.
 * Prefers `lastChangedAt` when present; falls back to the slice reference.
 */
function extractVersion<T>(slice: T | undefined): unknown {
  if (slice === undefined) return undefined
  if (
    slice !== null &&
    typeof slice === 'object' &&
    'lastChangedAt' in slice &&
    typeof (slice as Record<string, unknown>).lastChangedAt === 'number'
  ) {
    return (slice as Record<string, unknown>).lastChangedAt
  }
  return slice
}

export function useOptimisticSlice<T extends object>(
  realSlice: T | undefined,
  opts?: UseOptimisticSliceOptions,
): UseOptimisticSliceResult<T> {
  const enabled = opts?.enabled !== false
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // The optimistic override: undefined means "no active override — show real slice".
  const [override, setOverride] = useState<T | undefined>(undefined)

  // Ref mirror of the override state: always current even within a render cycle.
  // Used in applyOptimistic so rapid successive patches accumulate correctly
  // without depending on the (potentially stale) `override` state value.
  const overrideRef = useRef<T | undefined>(undefined)

  // The slice-version snapshot captured at the moment applyOptimistic was called.
  // We watch for the real slice advancing past this snapshot to trigger reconcile.
  const versionAtApplyRef = useRef<unknown>(undefined)

  // Guard: only clear the override when the version has genuinely advanced
  // (not just from `undefined` on mount).
  const overrideActiveRef = useRef(false)

  // Commands run through applyOptimisticAction that have not settled yet.
  const pendingRef = useRef(0)

  // The latest real slice, readable from a settled promise.
  const realSliceRef = useRef<T | undefined>(realSlice)
  realSliceRef.current = realSlice

  // Timeout handle for the fallback clear.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearOverride = useCallback((): void => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }
    overrideRef.current = undefined
    overrideActiveRef.current = false
    versionAtApplyRef.current = undefined
    pendingRef.current = 0
    setOverride(undefined)
  }, [])

  // Reconcile: when the real slice advances, clear the override.
  useEffect(() => {
    // While a command is in flight the override stays: its outcome decides.
    if (!enabled || !overrideActiveRef.current || pendingRef.current > 0) return
    const currentVersion = extractVersion(realSlice)
    const capturedVersion = versionAtApplyRef.current
    // The slice advanced if the version is defined and different from the snapshot.
    if (currentVersion !== undefined && currentVersion !== capturedVersion) {
      clearOverride()
    }
  })

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current)
    }
  }, [])

  const applyPatch = useCallback(
    (patch: Partial<T>, armSafetyNet: boolean): void => {
      if (!enabled) return
      // Cancel any pending fallback timeout from a previous optimistic patch.
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = undefined
      }
      // Build the override: merge the patch onto the current base so that rapid
      // successive patches accumulate correctly. We use overrideRef (the ref mirror
      // of state) rather than the `override` state variable to avoid reading a stale
      // closure value when two applyOptimistic calls happen within the same render.
      // Only apply when a base is available — without any slice there is nothing to patch.
      const base = overrideRef.current ?? realSlice
      if (base !== undefined) {
        const next: T = { ...base, ...patch }
        overrideRef.current = next
        setOverride(next)
      }
      // Capture the version of the real slice at the time of the apply.
      versionAtApplyRef.current = extractVersion(realSlice)
      overrideActiveRef.current = true
      // Fallback: clear after timeoutMs even if no push arrives. (applyOptimisticAction
      // holds the net until its command settles.)
      if (armSafetyNet) timeoutRef.current = setTimeout(clearOverride, timeoutMs)
    },
    [enabled, realSlice, clearOverride, timeoutMs],
  )

  const applyOptimistic = useCallback(
    (patch: Partial<T>): void => applyPatch(patch, true),
    [applyPatch],
  )

  const applyOptimisticAction = useCallback(
    (
      patch: Partial<T>,
      run: () => PromiseLike<unknown> | undefined,
      onError?: (error: unknown) => void,
    ): void => {
      // A synchronous throw is a refusal like any other.
      const started = new Promise<unknown>((resolve) => resolve(run()))
      if (!enabled) {
        started.catch((err: unknown) => onError?.(err))
        return
      }
      applyPatch(patch, false)
      pendingRef.current += 1
      started.then(
        () => {
          pendingRef.current = Math.max(0, pendingRef.current - 1)
          if (pendingRef.current > 0 || !overrideActiveRef.current) return
          // The slice may have caught up while the command was in flight.
          const current = extractVersion(realSliceRef.current)
          if (current !== undefined && current !== versionAtApplyRef.current) {
            clearOverride()
            return
          }
          if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current)
          timeoutRef.current = setTimeout(clearOverride, timeoutMs)
        },
        (err: unknown) => {
          // The server refused: never keep showing a state it did not produce.
          clearOverride()
          onError?.(err)
        },
      )
    },
    [enabled, applyPatch, clearOverride, timeoutMs],
  )

  if (!enabled) {
    return {
      display: realSlice,
      applyOptimistic: () => {
        /* no-op */
      },
      rollback: () => {
        /* no-op — no override was ever applied */
      },
      applyOptimisticAction: (_patch, run, onError) => {
        new Promise((resolve) => resolve(run())).catch((err: unknown) => onError?.(err))
      },
    }
  }

  return {
    display: override !== undefined ? override : realSlice,
    applyOptimistic,
    rollback: clearOverride,
    applyOptimisticAction,
  }
}
