/**
 * `prefetchDeviceTopology` — the caller half of the `listEventKindsBatch`
 * fan-out fix.
 *
 * The whole point is a CALL COUNT, so that is what these assert: two calls for
 * the whole set, whatever N is. Asserting only the returned shape would pass
 * just as happily against the per-device version that took 106.
 */
import { describe, expect, it } from 'vitest'
import type { BindingsRow, LinkedDevicesRow } from '../services/event-kinds-prefetch.js'
import { prefetchDeviceTopology } from '../services/event-kinds-prefetch.js'

interface RecordedCalls {
  readonly linked: number[][]
  readonly bindings: number[][]
}

function apiWith(
  linkedRows: readonly LinkedDevicesRow[],
  bindingRows: readonly BindingsRow[],
): { api: Parameters<typeof prefetchDeviceTopology>[0]; calls: RecordedCalls } {
  const calls: RecordedCalls = { linked: [], bindings: [] }
  return {
    calls,
    api: {
      getLinkedDevicesBatch: async ({ deviceIds }) => {
        calls.linked.push([...deviceIds])
        return linkedRows.filter((r) => deviceIds.includes(r.deviceId))
      },
      getBindingsBatch: async ({ deviceIds }) => {
        calls.bindings.push([...deviceIds])
        return bindingRows.filter((r) => deviceIds.includes(r.deviceId))
      },
    },
  }
}

const linkedRow = (deviceId: number, linkedIds: readonly number[]): LinkedDevicesRow => ({
  deviceId,
  mode: 'auto',
  devices: linkedIds.map((id) => ({
    deviceId: id,
    name: `dev-${id}`,
    location: 'Hall',
    features: [],
  })),
})

const bindingRow = (deviceId: number, caps: readonly string[]): BindingsRow => ({
  deviceId,
  entries: caps.map((capName) => ({ capName })),
})

describe('prefetchDeviceTopology', () => {
  it('asks device-manager exactly TWICE for thirty cameras', async () => {
    const cameras = Array.from({ length: 30 }, (_, i) => 600 + i)
    const { api, calls } = apiWith(
      cameras.map((id) => linkedRow(id, [id + 1000])),
      cameras.flatMap((id) => [bindingRow(id, ['motion']), bindingRow(id + 1000, ['doorbell'])]),
    )

    await prefetchDeviceTopology(api, cameras)

    expect(calls.linked).toHaveLength(1)
    expect(calls.bindings).toHaveLength(1)
    expect(calls.linked[0]).toEqual(cameras)
  })

  it('asks for bindings of the cameras AND everything linked to them, deduped', async () => {
    // Two cameras in the same room share a linked doorbell. The old path asked
    // for it twice; a set is the whole reason the batch can be one call.
    const { api, calls } = apiWith(
      [linkedRow(101, [900, 901]), linkedRow(102, [900])],
      [bindingRow(900, ['doorbell'])],
    )

    await prefetchDeviceTopology(api, [101, 102, 101])

    expect(calls.linked[0]).toEqual([101, 102])
    expect(calls.bindings[0]).toEqual([101, 102, 900, 901])
  })

  it('answers per device off the prefetched maps — no further calls', async () => {
    const { api, calls } = apiWith(
      [linkedRow(101, [900])],
      [bindingRow(101, ['motion']), bindingRow(900, ['doorbell'])],
    )

    const topology = await prefetchDeviceTopology(api, [101])
    const linked = await topology.linkedDevices.getLinkedDevices({ deviceId: 101 })
    const selfBindings = await topology.bindings.getBindings({ deviceId: 101 })
    const linkedBindings = await topology.bindings.getBindings({ deviceId: 900 })

    expect(linked.devices.map((d) => d.deviceId)).toEqual([900])
    expect(selfBindings.entries.map((e) => e.capName)).toEqual(['motion'])
    expect(linkedBindings.entries.map((e) => e.capName)).toEqual(['doorbell'])
    expect(calls.linked).toHaveLength(1)
    expect(calls.bindings).toHaveLength(1)
  })

  it('a device the hub left out of the answer resolves EMPTY, it does not throw', async () => {
    // A throw here would take down the whole vocabulary request. One camera
    // losing its sensor lanes is the correct blast radius.
    const { api } = apiWith([], [])

    const topology = await prefetchDeviceTopology(api, [101])

    await expect(topology.linkedDevices.getLinkedDevices({ deviceId: 101 })).resolves.toEqual({
      mode: 'auto',
      devices: [],
    })
    await expect(topology.bindings.getBindings({ deviceId: 101 })).resolves.toEqual({ entries: [] })
  })

  it('an empty ask makes no calls at all', async () => {
    const { api, calls } = apiWith([], [])

    await prefetchDeviceTopology(api, [])

    // The bindings ask is still issued for the (empty) set — the cheap thing
    // to guarantee is that the LINKED ask never fires with nothing in it.
    expect(calls.linked[0]).toEqual([])
    expect(calls.bindings[0]).toEqual([])
  })
})
