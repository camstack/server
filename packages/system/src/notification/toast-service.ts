import type { Toast } from '@camstack/types'

export type Unsubscribe = () => void

interface ListenerEntry {
  readonly userId: string
  readonly callback: (toast: Toast) => void
}

/**
 * Service for broadcasting toast notifications to connected UI clients.
 * Framework-agnostic — integrates with tRPC subscriptions via subscribe().
 */
export class ToastService {
  private readonly listeners = new Map<string, ListenerEntry>()

  /**
   * Subscribe to toast events for a specific user.
   * Returns an unsubscribe function.
   */
  subscribe(connectionId: string, userId: string, callback: (toast: Toast) => void): Unsubscribe {
    this.listeners.set(connectionId, { userId, callback })
    return () => {
      this.listeners.delete(connectionId)
    }
  }

  /**
   * Broadcast a toast to all connected clients.
   */
  broadcast(toast: Toast): void {
    for (const entry of this.listeners.values()) {
      entry.callback(toast)
    }
  }

  /**
   * Send a toast to a specific user's connections only.
   */
  sendToUser(userId: string, toast: Toast): void {
    for (const entry of this.listeners.values()) {
      if (entry.userId === userId) {
        entry.callback(toast)
      }
    }
  }
}
