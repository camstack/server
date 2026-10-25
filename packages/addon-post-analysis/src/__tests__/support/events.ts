import {
  EventCategory,
  type AudioEvent,
  type EventSource,
  type ObjectEvent,
  type SystemEvent,
} from '@camstack/types'

let eventIdSeq = 100_000

function bumpEventId(): number {
  eventIdSeq += 1
  return eventIdSeq
}

export function makeTestObjectEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: bumpEventId(),
    kind: 'object',
    deviceId: 104,
    timestamp: 100_000,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: ['gate'],
    ...overrides,
  }
}

/** `DeviceStateChanged` as emitted by `device-state-mirror` — not in {@link createEvent}'s catalog typing. */
export function makeDeviceStateChangedEvent(
  deviceId: number,
  capName: string,
  slice: Record<string, unknown>,
): SystemEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceStateChanged,
    data: { deviceId, capName, slice },
  }
}

/** Bus-shaped event when {@link createEvent} catalog is narrower than runtime payload. */
export function makeTestSystemEvent(
  category: string,
  source: EventSource,
  data: Record<string, unknown>,
  patch?: Partial<Pick<SystemEvent, 'id' | 'timestamp'>>,
): SystemEvent {
  return {
    id: patch?.id ?? 'test-event',
    timestamp: patch?.timestamp ?? new Date(123),
    source,
    category,
    data,
  }
}

export function makeTestAudioEvent(overrides: Partial<AudioEvent> = {}): AudioEvent {
  return {
    id: bumpEventId(),
    kind: 'audio',
    deviceId: 104,
    timestamp: 100_000,
    rms: 0.1,
    dbfs: -20,
    classification: { className: 'dog', score: 0.92 },
    ...overrides,
  }
}
