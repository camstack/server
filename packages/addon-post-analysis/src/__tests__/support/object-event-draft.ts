import type { ObjectEvent, ObjectEventDraft } from '@camstack/types'

/** Build an {@link ObjectEventDraft} for `EventStore.insertObject` — strips `id`. */
export function makeTestObjectEventDraft(overrides: Partial<ObjectEvent> = {}): ObjectEventDraft {
  const { id: _id, ...rest } = {
    kind: 'object' as const,
    deviceId: 104,
    timestamp: 100_000,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: ['gate'],
    state: 'new' as const,
    ...overrides,
  }
  return rest
}
