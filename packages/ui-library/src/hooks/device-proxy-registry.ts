/**
 * Shared per-client plumbing behind `useDeviceProxy`.
 *
 * A device list mounts several proxies per row (header, preview, features,
 * battery, reboot, PTZ). Each one used to fetch its own `getBindings` and open
 * its own `live.onEvent` subscriptions, so a 50-row page held 200+ websocket
 * subscriptions that each received the state events of every device. This
 * registry is keyed by the tRPC client and owns:
 *
 *  - ONE device-state slice source (one `device.state-changed` bridge, fanned
 *    out in memory by `{deviceId}:{capName}`), handed to every proxy;
 *  - ONE `capability.binding-changed` subscription, open while any proxy is
 *    mounted;
 *  - ONE `getBindings` fetch per observed device, shared by every hook of it,
 *    refetched only for the device a binding change names.
 *
 * An entry lives only while it is observed, so a remount starts from a fresh
 * fetch exactly as a fresh hook did before.
 */
import type { DeviceBinding, SliceHandleSource, createDeviceProxy } from '@camstack/types'
import { createLazyTrpcSource } from '@camstack/types'
import type { UseDeviceProxyTrpc } from './use-device-proxy.js'

const BINDING_CHANGED_CATEGORY = 'capability.binding-changed'

interface BindingEntry {
  binding: DeviceBinding | null
  observers: number
  inflight: boolean
  readonly listeners: Set<() => void>
}

export interface DeviceProxyRegistry {
  readonly stateSource: SliceHandleSource
  /** Observe a device's binding; returns the unsubscribe. */
  observe(deviceId: number, onChange: () => void): () => void
  /** Last resolved binding for a device, `null` until the first fetch lands. */
  read(deviceId: number): DeviceBinding | null
}

const registries = new WeakMap<object, DeviceProxyRegistry>()

export function getDeviceProxyRegistry(trpc: UseDeviceProxyTrpc): DeviceProxyRegistry {
  const existing = registries.get(trpc)
  if (existing) return existing
  const created = createRegistry(trpc)
  registries.set(trpc, created)
  return created
}

function createRegistry(trpc: UseDeviceProxyTrpc): DeviceProxyRegistry {
  const entries = new Map<number, BindingEntry>()
  let bindingSub: { unsubscribe: () => void } | null = null

  // Type boundary (same as `useDeviceProxy`): the vanilla tRPC client is
  // structurally the AddonApi the slice source expects.
  const stateSource = createLazyTrpcSource(trpc as Parameters<typeof createDeviceProxy>[0])

  const refetch = async (deviceId: number): Promise<void> => {
    const entry = entries.get(deviceId)
    if (!entry || entry.inflight) return
    entry.inflight = true
    try {
      const next = await trpc.deviceManager.getBindings.query({ deviceId })
      // The entry may have been dropped (or replaced) while the query ran.
      if (entries.get(deviceId) !== entry) return
      entry.binding = next
      for (const cb of entry.listeners) cb()
    } catch {
      // A transient failure leaves the previous binding in place so active
      // subscriptions are not torn down.
    } finally {
      entry.inflight = false
    }
  }

  const openBindingSub = (): void => {
    if (bindingSub || !trpc.live) return
    bindingSub = trpc.live.onEvent.subscribe(
      { category: BINDING_CHANGED_CATEGORY },
      {
        onData: (evt) => {
          const src = evt.data?.source
          if (!src) {
            for (const id of [...entries.keys()]) void refetch(id)
            return
          }
          if (src.type === 'device' && typeof src.id === 'number') void refetch(src.id)
        },
      },
    )
  }

  return {
    stateSource,
    read: (deviceId) => entries.get(deviceId)?.binding ?? null,
    observe(deviceId, onChange) {
      const existing = entries.get(deviceId)
      const entry: BindingEntry = existing ?? {
        binding: null,
        observers: 0,
        inflight: false,
        listeners: new Set(),
      }
      if (!existing) entries.set(deviceId, entry)
      entry.observers += 1
      entry.listeners.add(onChange)
      openBindingSub()
      if (!existing) void refetch(deviceId)
      return () => {
        entry.listeners.delete(onChange)
        entry.observers -= 1
        if (entry.observers > 0) return
        if (entries.get(deviceId) === entry) entries.delete(deviceId)
        if (entries.size === 0 && bindingSub) {
          bindingSub.unsubscribe()
          bindingSub = null
        }
      }
    },
  }
}
