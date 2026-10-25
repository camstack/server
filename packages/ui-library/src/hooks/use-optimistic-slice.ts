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
 *   (b) A fallback timeout (`timeoutMs`, default 4000ms) elapses without a push,
 *       so stale optimistic state is never stuck indefinitely.
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
    setOverride(undefined)
  }, [])

  // Reconcile: when the real slice advances, clear the override.
  useEffect(() => {
    if (!enabled || !overrideActiveRef.current) return
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

  const applyOptimistic = useCallback(
    (patch: Partial<T>): void => {
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
      // Fallback: clear after timeoutMs even if no push arrives.
      timeoutRef.current = setTimeout(clearOverride, timeoutMs)
    },
    [enabled, realSlice, clearOverride, timeoutMs],
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
    }
  }

  return {
    display: override !== undefined ? override : realSlice,
    applyOptimistic,
    rollback: clearOverride,
  }
}
