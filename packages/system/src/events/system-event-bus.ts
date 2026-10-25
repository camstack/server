import type { EventSource, SystemEvent, EventFilter, IEventBus } from '@camstack/types'

export type { EventSource, SystemEvent, EventFilter }

interface Subscriber {
  readonly filter: EventFilter
  readonly callback: (event: SystemEvent) => void
}

class EventRingBuffer {
  private readonly buffer: Array<SystemEvent | undefined>
  private head = 0
  private count = 0

  constructor(private readonly capacity: number) {
    this.buffer = Array.from<SystemEvent | undefined>({ length: capacity })
  }

  push(event: SystemEvent): void {
    this.buffer[this.head] = event
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  getAll(): readonly SystemEvent[] {
    const result: SystemEvent[] = []
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - 1 - i + this.capacity) % this.capacity
      result.push(this.buffer[index]!)
    }
    return result
  }

  query(filter?: EventFilter, limit?: number): readonly SystemEvent[] {
    let result = [...this.getAll()]

    if (filter) {
      result = result.filter((event) => matchesFilter(event, filter))
    }

    if (limit !== undefined && limit > 0) {
      return result.slice(0, limit)
    }

    return result
  }
}

function matchesCategory(eventCategory: string, filterCategory: string): boolean {
  if (filterCategory.endsWith('.*')) {
    const prefix = filterCategory.slice(0, -2)
    return eventCategory.startsWith(prefix + '.') || eventCategory === prefix
  }
  return eventCategory === filterCategory
}

function matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
  if (filter.category) {
    const raw = filter.category
    const categories: string[] = Array.isArray(raw) ? raw.map(String) : [String(raw)]
    if (!categories.some((cat) => matchesCategory(event.category, cat))) {
      return false
    }
  }

  if (filter.source) {
    if (event.source.type !== filter.source.type || event.source.id !== filter.source.id) {
      return false
    }
  }

  if (filter.agentId) {
    const eventNodeId = event.source.nodeId
    // Prefix match: 'hub' matches 'hub', 'hub/pipeline', etc.
    if (!eventNodeId || !eventNodeId.startsWith(filter.agentId)) {
      return false
    }
  }

  if (filter.addonId) {
    const eventAddonId =
      event.source.addonId ?? (event.source.type === 'addon' ? String(event.source.id) : undefined)
    if (eventAddonId !== filter.addonId) {
      return false
    }
  }

  if (filter.deviceId !== undefined) {
    const eventDeviceId =
      event.source.deviceId ??
      (event.source.type === 'device' ? Number(event.source.id) : undefined)
    if (eventDeviceId !== filter.deviceId) {
      return false
    }
  }

  if (filter.since && event.timestamp < filter.since) {
    return false
  }

  return true
}

export class SystemEventBus implements IEventBus {
  private readonly ringBuffer: EventRingBuffer
  private readonly subscribers: Subscriber[] = []

  constructor(bufferSize: number = 10000) {
    this.ringBuffer = new EventRingBuffer(bufferSize)
  }

  emit(event: SystemEvent): void {
    this.ringBuffer.push(event)

    for (const subscriber of this.subscribers) {
      if (matchesFilter(event, subscriber.filter)) {
        queueMicrotask(() => {
          try {
            subscriber.callback(event)
          } catch (err) {
            console.error(`[EventBus] Subscriber error for ${event.category}:`, err)
          }
        })
      }
    }
  }

  /**
   * Subscribe to events matching a filter.
   * When called with a typed category filter, the handler receives typed event data.
   */
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    const subscriber: Subscriber = { filter, callback: handler }
    this.subscribers.push(subscriber)

    return () => {
      const index = this.subscribers.indexOf(subscriber)
      if (index !== -1) {
        this.subscribers.splice(index, 1)
      }
    }
  }

  getRecent(filter?: EventFilter, limit?: number): readonly SystemEvent[] {
    return this.ringBuffer.query(filter, limit)
  }
}
