/**
 * One pair of device-manager calls for a WHOLE set of cameras, instead of two
 * per camera.
 *
 * `composeEventKinds` asks device-manager two questions per camera — "what is
 * linked to it" and "what caps are bound" (its own, then each linked device's).
 * Both are per-device cap methods, so `listEventKindsBatch` over N cameras was
 * 1 + N + (N + linked) round-trips. Measured on the live hub 2026-08-25 over
 * this deployment's 30 cameras:
 *
 *   30x getLinkedDevices, concurrent   4110 ms   7 260 B    (median 4060 ms each)
 *   75x getBindings, concurrent        1211 ms   117 567 B
 *   listEventKindsBatch(30)            2178–9377 ms
 *
 * `getLinkedDevices` is the one that hurts and it is not the bytes: resolving
 * one camera's linked set needs the whole fleet as candidates, so each call
 * runs a full `listAll` on device-manager's event loop, and thirty of them
 * queue rather than overlap.
 *
 * The fix is on the device-manager side (`getLinkedDevicesBatch` /
 * `getBindingsBatch`, one fleet sweep for the set). This module is the caller
 * half: it fetches both up front and hands `composeEventKinds` the SAME
 * per-device client interfaces, backed by maps. Composition logic — including
 * the single-camera path, which still fetches per device because for one
 * camera that IS the batch — is untouched.
 */
import type { DeviceBindingsClient, LinkedDeviceEntry, LinkedDevicesClient } from './event-kinds.js'

/** One row of `deviceManager.getLinkedDevicesBatch`. */
export interface LinkedDevicesRow {
  readonly deviceId: number
  readonly mode: 'auto' | 'manual'
  readonly devices: readonly LinkedDeviceEntry[]
}

/** One row of `deviceManager.getBindingsBatch`. */
export interface BindingsRow {
  readonly deviceId: number
  readonly entries: ReadonlyArray<{ readonly capName: string }>
}

/** The two batch reads this module needs, and nothing else of `ctx.api`. */
export interface DeviceTopologyBatchApi {
  getLinkedDevicesBatch(input: { deviceIds: number[] }): Promise<readonly LinkedDevicesRow[]>
  getBindingsBatch(input: { deviceIds: number[] }): Promise<readonly BindingsRow[]>
}

/** Prefetched answers, wearing the per-device interfaces `composeEventKinds` consumes. */
export interface PrefetchedTopology {
  readonly linkedDevices: LinkedDevicesClient
  readonly bindings: DeviceBindingsClient
}

/**
 * Resolve linked devices and bindings for `deviceIds` in two calls.
 *
 * Sequential by necessity, not by oversight: the binding set is cameras PLUS
 * everything linked to them, and the linked set is what the first call
 * returns.
 *
 * A camera or linked device missing from a batch answer resolves EMPTY rather
 * than throwing. Both batch endpoints answer for every id they were given, so
 * a gap here is a hub that answered a shorter array than it was asked for —
 * one camera loses its sensor lanes, never the whole request.
 */
export async function prefetchDeviceTopology(
  api: DeviceTopologyBatchApi,
  deviceIds: readonly number[],
): Promise<PrefetchedTopology> {
  const ids = [...new Set(deviceIds)]
  const linkedRows = await api.getLinkedDevicesBatch({ deviceIds: ids })
  const linkedByDevice = new Map(linkedRows.map((row) => [row.deviceId, row]))

  const bindingTargets = new Set<number>(ids)
  for (const row of linkedRows) {
    for (const linked of row.devices) bindingTargets.add(linked.deviceId)
  }
  const bindingRows = await api.getBindingsBatch({ deviceIds: [...bindingTargets] })
  const bindingsByDevice = new Map(bindingRows.map((row) => [row.deviceId, row]))

  return {
    linkedDevices: {
      getLinkedDevices: async ({ deviceId }) =>
        linkedByDevice.get(deviceId) ?? { mode: 'auto', devices: [] },
    },
    bindings: {
      getBindings: async ({ deviceId }) => bindingsByDevice.get(deviceId) ?? { entries: [] },
    },
  }
}
