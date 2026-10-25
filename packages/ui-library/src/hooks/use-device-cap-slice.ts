/**
 * useDeviceCapSlice — generic runtime-state slice reader for an arbitrary
 * capability name (kebab-case string, e.g. `'vacuum-control'`).
 *
 * The typed `useDeviceState` combinator in `use-device-proxy.ts` requires a
 * typed selector into `DeviceProxyState`, which only has named camelCase
 * properties. When the caller only has the cap name as a runtime string (e.g.
 * from a `DeviceLink.target.cap` field), there is no typed accessor available.
 *
 * This hook builds a one-off `SliceHandle<unknown>` directly from the tRPC
 * client, bypassing the typed bag entirely:
 *
 *   const slice = useDeviceCapSlice(trpc, deviceId, 'vacuum-control')
 *
 * The returned value is `unknown | undefined` — callers should use `getByPath`
 * for further field-level reads, just like link resolution does server-side.
 *
 * The lazy source is memoised by `(trpc, deviceId, capName)` identity so React
 * doesn't rebuild the subscription cache on every render.
 */
import { useRef } from 'react'
import { createLazyTrpcSource, createSliceHandle, type SliceHandleApi } from '@camstack/types'
import { useDeviceStateSlice } from './use-device-proxy.js'

/**
 * The tRPC shape required by this hook — a superset of `UseDeviceProxyTrpc`
 * that also exposes `deviceState.getCapSlice` and `deviceState.setCapSlice`
 * so the lazy source can bootstrap a per-cap subscription.
 *
 * `System.trpcClient` satisfies this structurally.
 */
export type UseDeviceCapSliceTrpc = SliceHandleApi

/**
 * Read an arbitrary cap's runtime-state slice by its raw kebab-case name.
 *
 * Returns `unknown | undefined`:
 *  - `undefined` while the slice hasn't been seeded yet (cold-start)
 *  - the raw slice record once the kernel has published at least one push
 *
 * Pass `null` for `deviceId` to suppress all fetches (renders `undefined`).
 */
export function useDeviceCapSlice(
  trpc: UseDeviceCapSliceTrpc,
  deviceId: number | null,
  capName: string,
): unknown | undefined {
  // Keep the source stable across renders — rebuilding it would tear down
  // and re-create the internal subscription cache on every render cycle.
  // A ref keyed by `(trpc, deviceId, capName)` satisfies this without
  // adding the source as a hook dependency.
  const sourceRef = useRef<ReturnType<typeof createLazyTrpcSource> | null>(null)
  const prevTrpcRef = useRef<UseDeviceCapSliceTrpc | null>(null)
  if (sourceRef.current === null || prevTrpcRef.current !== trpc) {
    sourceRef.current = createLazyTrpcSource(trpc)
    prevTrpcRef.current = trpc
  }

  // Keep the HANDLE stable too — `useDeviceStateSlice` takes the handle as a
  // subscription dependency, so a fresh handle every render would re-subscribe
  // each cycle. Rebuild it only when `(trpc, deviceId, capName)` actually change.
  const handleRef = useRef<ReturnType<typeof createSliceHandle<unknown>> | undefined>(undefined)
  const handleDepsRef = useRef<{ source: unknown; deviceId: number; capName: string } | null>(null)
  const deps = handleDepsRef.current
  if (deviceId === null) {
    handleRef.current = undefined
    handleDepsRef.current = null
  } else if (
    handleRef.current === undefined ||
    deps === null ||
    deps.source !== sourceRef.current || // source rebuilt (trpc changed)
    deps.deviceId !== deviceId ||
    deps.capName !== capName
  ) {
    handleRef.current = createSliceHandle<unknown>(sourceRef.current, deviceId, capName)
    handleDepsRef.current = { source: sourceRef.current, deviceId, capName }
  }

  return useDeviceStateSlice(handleRef.current)
}
