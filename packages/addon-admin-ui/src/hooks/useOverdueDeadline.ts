import { useEffect, useState } from 'react'

/**
 * Returns `true` once `deadlineMs` has elapsed while `active` stays true —
 * a "this is taking longer than expected" signal for otherwise-indefinite
 * waits (e.g. a creation modal's "waiting for the integration to reload"
 * spinner). Resets to `false` the moment `active` goes false again, and the
 * pending timer is cancelled so a late tick can never flip a dismissed
 * wait back to overdue.
 *
 * The point is that a UI wait MUST have an escape hatch: a spinner that can
 * hang forever traps the operator. Callers use the overdue flag to re-enable
 * a close affordance and surface "it may still be completing — close and
 * refresh" instead of spinning silently.
 */
export function useOverdueDeadline(active: boolean, deadlineMs: number): boolean {
  const [overdue, setOverdue] = useState(false)

  useEffect(() => {
    if (!active) {
      // Going inactive both resets the flag and (via cleanup below) cancels
      // any armed timer.
      setOverdue(false)
      return
    }
    setOverdue(false)
    const timer = setTimeout(() => setOverdue(true), deadlineMs)
    return () => clearTimeout(timer)
  }, [active, deadlineMs])

  return overdue
}
