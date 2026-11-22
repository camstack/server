import type { System } from '@camstack/sdk'
import { resolveFixture } from '../fixtures-runtime'
import { fakeClient } from './transport'

const noop = () => () => undefined
const EVENT_REPLAY_DELAY_MS = 50

/**
 * A fixture handler keyed `event:<category>` is replayed once to each new subscriber of that
 * category: its value (or each element, when an array; a function gets no input) is the event's
 * `data`. Pages that derive their rows from the live stream can then be shot.
 */
function subscribeFixtureEvent(
  category: string,
  cb: (event: {
    id: string
    timestamp: Date
    source: { type: string; id: string }
    category: string
    data: unknown
  }) => void,
): () => void {
  const answer = resolveFixture(`event:${category}`, undefined, false)
  if (!answer.found || answer.value === null || answer.value === undefined) return () => undefined
  const payloads = Array.isArray(answer.value) ? answer.value : [answer.value]
  const timer = setTimeout(() => {
    payloads.forEach((data, index) => {
      cb({
        id: `fixture-${category}-${index}`,
        timestamp: new Date(),
        source: { type: 'fixture', id: category },
        category,
        data,
      })
    })
  }, EVENT_REPLAY_DELAY_MS)
  return () => clearTimeout(timer)
}
let instance: System | null = null

function make(): System {
  const trpcClient = fakeClient() as unknown as Record<string, unknown>
  const known: Record<string, unknown> = {
    trpcClient,
    serverUrl: 'https://camstack.example.com',
    connectionVersion: 1,
    subscribeConnectionEvents: noop,
    onEvent: noop,
    onEvents: noop,
    subscribeEvents: noop,
    subscribeEvent: subscribeFixtureEvent,
    onDeviceAdded: noop,
    onDeviceRemoved: noop,
    awaitConnected: async () => undefined,
    init: async () => undefined,
    close: () => undefined,
    reconnect: () => undefined,
    setToken: () => undefined,
    isReady: () => true,
    getOwnTotpStatus: async () => ({ enabled: true, confirmedAt: Date.UTC(2026, 7, 20) }),
    isConnected: () => true,
    listDevices: () => [],
    listDeviceInfos: () => [],
    getDeviceInfo: () => null,
    getDevice: () => null,
    getDeviceByName: () => null,
    getDeviceByStableId: () => null,
  }
  return new Proxy(known, {
    get(t, p: string | symbol) {
      if (typeof p === 'symbol') return undefined
      if (p in t) return t[p]
      if (p === 'then') return undefined
      return trpcClient[p]
    },
  }) as unknown as System
}

export function getSystem(): System {
  instance ??= make()
  return instance
}
export function resetSystem(): void {}
