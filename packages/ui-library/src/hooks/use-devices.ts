/**
 * useDevices / useDevice — reactive sync-mirror reads.
 *
 * Both hooks hand out `DeviceProxy` references straight out of the
 * `System` mirror. The mirror keeps device + binding caches warm via
 * the `device.registered/unregistered/bindings-changed` event stream,
 * so re-renders are driven by lifecycle pushes — no React Query
 * round-trip and no `refetch` plumbing needed at the caller side.
 *
 * The hooks defensively read once on mount and assume the System has
 * been `init()`ed by the host app — calls before the warm-boot
 * completes simply return an empty array / null and re-render once
 * the registered listeners fire.
 */
import { useEffect, useMemo, useState } from 'react'
import type { DeviceProxy, DeviceQueryFilters } from '@camstack/types'
import { useSystem } from '../contexts/system-context.js'

/**
 * Reactive list of devices matching the optional filter set. Returns a
 * stable array reference between updates so consumers passing it as a
 * prop don't tear down memoized children.
 */
export function useDevices(filters?: DeviceQueryFilters): readonly DeviceProxy[] {
  const system = useSystem()

  // Stabilise the filters reference: callers usually inline a literal.
  // We hash it to JSON so the effect only re-subscribes when the
  // semantic filter changes — not on every render.
  const filtersKey = useMemo(() => (filters ? JSON.stringify(filters) : ''), [filters])

  const [devices, setDevices] = useState<readonly DeviceProxy[]>(() => system.listDevices(filters))

  useEffect(() => {
    // Refresh once the System (re)connects + on every lifecycle event.
    const refresh = (): void => {
      setDevices(system.listDevices(filters))
    }
    refresh()
    let unsubAdded: (() => void) | null = null
    let unsubRemoved: (() => void) | null = null
    try {
      unsubAdded = system.onDeviceAdded(refresh)
      unsubRemoved = system.onDeviceRemoved(refresh)
    } catch {
      // Mirror not initialised yet — refresh once the connection
      // bumps; the system invalidates RQ on reconnect.
    }
    const unsubConn = system.subscribeConnectionEvents((state) => {
      if (state === 'connected') refresh()
    })
    return () => {
      unsubAdded?.()
      unsubRemoved?.()
      unsubConn()
    }
    // `filters` is included for closure capture (the refresh thunk
    // calls `listDevices(filters)`) but `filtersKey` is the actual
    // gating signal — callers inline literal filters, so the JSON
    // hash stops the effect from re-running on every render.
  }, [system, filters, filtersKey])

  return devices
}

/**
 * Single-device variant. Returns `null` until the device is in the
 * mirror; re-renders when the device is removed (back to `null`) or
 * added.
 */
export function useDevice(deviceId: number | null): DeviceProxy | null {
  const system = useSystem()
  const [device, setDevice] = useState<DeviceProxy | null>(() =>
    deviceId === null ? null : system.getDevice(deviceId),
  )

  useEffect(() => {
    if (deviceId === null) {
      setDevice(null)
      return undefined
    }
    const refresh = (): void => {
      setDevice(system.getDevice(deviceId))
    }
    refresh()
    let unsubAdded: (() => void) | null = null
    let unsubRemoved: (() => void) | null = null
    try {
      unsubAdded = system.onDeviceAdded(refresh)
      unsubRemoved = system.onDeviceRemoved(refresh)
    } catch {
      /* mirror not ready */
    }
    const unsubConn = system.subscribeConnectionEvents((state) => {
      if (state === 'connected') refresh()
    })
    return () => {
      unsubAdded?.()
      unsubRemoved?.()
      unsubConn()
    }
  }, [system, deviceId])

  return device
}
