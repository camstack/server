import type { ShcEventNotification } from './shc-types.js'

/** Notifications inside a long-poll body, a bare array, or `{ events: [] }`. */
export function shcEventsFromPayload(payload: unknown): readonly ShcEventNotification[] {
  if (Array.isArray(payload)) return readEvents(payload)
  if (payload === null || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  if (Array.isArray(root['result'])) return readEvents(root['result'])
  if (Array.isArray(root['events'])) return readEvents(root['events'])
  const one = readEvent(root)
  return one === null ? [] : [one]
}

function readEvents(rows: readonly unknown[]): ShcEventNotification[] {
  const events: ShcEventNotification[] = []
  for (const row of rows) {
    const event = readEvent(row)
    if (event !== null) events.push(event)
  }
  return events
}

function readEvent(row: unknown): ShcEventNotification | null {
  if (row === null || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  const deviceId = rec['deviceId']
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null
  const serviceId =
    typeof rec['id'] === 'string'
      ? rec['id']
      : typeof rec['serviceId'] === 'string'
        ? rec['serviceId']
        : undefined
  const eventType = typeof rec['eventType'] === 'string' ? rec['eventType'] : undefined
  return { deviceId, serviceId, eventType }
}
