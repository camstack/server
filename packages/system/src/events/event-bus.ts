type EventCallback<T = unknown> = (data: T) => void

export class EventBus {
  private listeners = new Map<string, Set<EventCallback>>()

  on<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    const set = this.listeners.get(event)!
    set.add(callback as EventCallback)
    return () => set.delete(callback as EventCallback)
  }

  emit<T = unknown>(event: string, data: T): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const cb of set) {
      try {
        cb(data)
      } catch {
        /* don't let one listener break others */
      }
    }
  }

  once<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    const unsub = this.on<T>(event, (data) => {
      unsub()
      callback(data)
    })
    return unsub
  }

  removeAllListeners(event?: string): void {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}
