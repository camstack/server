/**
 * A local way into the ONE `ToastContainer`: the server's `toast.onToast`
 * subscription is not the only thing that has something to say. A page that
 * just finished an operation calls `pushToast` and the same container shows it.
 */
import type { Toast } from '@camstack/types'

export type LocalToast = Pick<Toast, 'title' | 'message' | 'severity'> & {
  readonly duration?: number
}

type Listener = (toast: LocalToast) => void

const listeners = new Set<Listener>()

/** Show a toast in the shared container. A no-op while none is mounted. */
export function pushToast(toast: LocalToast): void {
  for (const listener of listeners) listener(toast)
}

/** The container's side: returns the unsubscribe. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
