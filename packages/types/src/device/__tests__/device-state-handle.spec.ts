import { describe, it, expect, vi } from 'vitest'
import {
  createEventBusSliceSource,
  createSliceHandle,
  type SliceEventBus,
  type SliceHandleApi,
} from '../device-state-handle.js'

/** No spec here writes; the port is required by the type, and refuses loudly if reached. */
const noWrite: SliceHandleApi['deviceState']['setCapSlice'] = {
  mutate: async () => {
    throw new Error('this harness does not write slices')
  },
}

interface BatterySlice {
  percentage: number
  charging: 'dc' | 'solar' | 'none'
  sleeping: boolean
  lastUpdated: number
}

function makeApi(opts: { initialSlice?: BatterySlice | null; withLive?: boolean }): {
  api: SliceHandleApi
  emit: (data: unknown) => void
  query: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const query = vi.fn(
    async () => opts.initialSlice ?? null,
  ) as unknown as SliceHandleApi['deviceState']['getCapSlice']['query']
  const queryMock = query as unknown as ReturnType<typeof vi.fn>

  let pushFn: ((evt: { data: unknown }) => void) | null = null
  const unsubscribe = vi.fn()

  const api: SliceHandleApi = {
    deviceState: { getCapSlice: { query }, setCapSlice: noWrite },
    ...(opts.withLive
      ? {
          live: {
            onEvent: {
              subscribe: (_input, handlers) => {
                pushFn = handlers.onData
                return { unsubscribe }
              },
            },
          },
        }
      : {}),
  }

  return {
    api,
    emit: (data) => {
      if (pushFn) pushFn({ data })
    },
    query: queryMock,
    unsubscribe,
  }
}

describe('createSliceHandle', () => {
  it('returns undefined value before any refresh or event', () => {
    const { api } = makeApi({ initialSlice: null, withLive: false })
    const h = createSliceHandle<BatterySlice>(api, 7, 'battery')
    expect(h.value).toBeUndefined()
  })

  it('refresh() pulls from getCapSlice and updates value', async () => {
    const initial: BatterySlice = {
      percentage: 80,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1,
    }
    const { api, query } = makeApi({ initialSlice: initial, withLive: false })
    const h = createSliceHandle<BatterySlice>(api, 7, 'battery')
    await h.refresh()
    expect(h.value).toEqual(initial)
    expect(query).toHaveBeenCalledWith({ deviceId: 7, capName: 'battery' })
  })

  it('subscribe() seeds via initial query and fires callback with slice', async () => {
    const initial: BatterySlice = {
      percentage: 50,
      charging: 'dc',
      sleeping: false,
      lastUpdated: 2,
    }
    const { api } = makeApi({ initialSlice: initial, withLive: true })
    const h = createSliceHandle<BatterySlice>(api, 7, 'battery')
    const cb = vi.fn()
    h.subscribe(cb)
    await new Promise((r) => setTimeout(r, 0))
    expect(cb).toHaveBeenCalledWith(initial)
  })

  it('routes only matching (deviceId, capName) live events to listeners', async () => {
    const { api, emit } = makeApi({ initialSlice: null, withLive: true })
    const h = createSliceHandle<BatterySlice>(api, 7, 'battery')
    const cb = vi.fn()
    h.subscribe(cb)
    await new Promise((r) => setTimeout(r, 0)) // let seed pass
    cb.mockClear()

    // Wrong device: ignored.
    emit({
      deviceId: 99,
      capName: 'battery',
      slice: { percentage: 1, charging: 'none', sleeping: false, lastUpdated: 0 },
    })
    expect(cb).not.toHaveBeenCalled()

    // Wrong cap: ignored.
    emit({ deviceId: 7, capName: 'motion', slice: {} })
    expect(cb).not.toHaveBeenCalled()

    // Match: delivered.
    const next: BatterySlice = {
      percentage: 42,
      charging: 'solar',
      sleeping: false,
      lastUpdated: 3,
    }
    emit({ deviceId: 7, capName: 'battery', slice: next })
    expect(cb).toHaveBeenCalledWith(next)
    expect(h.value).toEqual(next)
  })

  it('refcounts the bridge — unsubscribes from live transport when last listener leaves', async () => {
    const { api, unsubscribe } = makeApi({ initialSlice: null, withLive: true })
    const h = createSliceHandle<BatterySlice>(api, 7, 'battery')
    const off1 = h.subscribe(() => {})
    const off2 = h.subscribe(() => {})
    expect(unsubscribe).not.toHaveBeenCalled()
    off1()
    expect(unsubscribe).not.toHaveBeenCalled()
    off2()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('createEventBusSliceSource', () => {
  it('declares device.state-changed on the bus — that is the UDS interest', () => {
    const subscribe = vi.fn<SliceEventBus['subscribe']>(() => () => undefined)
    const query = vi.fn(async () => null)
    const source = createEventBusSliceSource({
      eventBus: { subscribe },
      api: { deviceState: { getCapSlice: { query }, setCapSlice: noWrite } },
    })
    source.watch(7, 'zones', () => undefined)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]?.[0]).toEqual({ category: 'device.state-changed' })
  })

  it('fans a matching slice event to the watcher and ignores a miss', () => {
    // A holder, not a `let`: a variable assigned only inside a callback is
    // narrowed to its initializer (`null`) at the call sites below.
    const bus: { handler: ((event: { data: unknown }) => void) | null } = { handler: null }
    const source = createEventBusSliceSource({
      eventBus: {
        subscribe: (_filter, h) => {
          bus.handler = h
          return () => undefined
        },
      },
      api: {
        deviceState: { getCapSlice: { query: vi.fn(async () => null) }, setCapSlice: noWrite },
      },
    })
    const cb = vi.fn()
    source.watch(7, 'zones', cb)
    cb.mockClear()
    bus.handler?.({ data: { deviceId: 99, capName: 'zones', slice: { zones: [] } } })
    expect(cb).not.toHaveBeenCalled()
    bus.handler?.({ data: { deviceId: 7, capName: 'zoneRules', slice: {} } })
    expect(cb).not.toHaveBeenCalled()
    const slice = { zones: [{ id: 'z1' }] }
    bus.handler?.({ data: { deviceId: 7, capName: 'zones', slice } })
    expect(cb).toHaveBeenCalledWith(slice)
    expect(source.read(7, 'zones')).toEqual(slice)
  })
})
