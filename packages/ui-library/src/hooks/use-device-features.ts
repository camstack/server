/**
 * useDeviceFeatures — resolve advertised `device.features` against the
 * live `deviceManager.getBindings` entries to produce a list that
 * tells the UI WHICH features are actually wired AND whether each
 * one comes from the native driver or an enhancing wrapper addon.
 *
 * Why this hook exists:
 *   `device.features` is an addon-side advertisement (a static list
 *   the driver pushes when probing the camera). It says "I claim to
 *   support X" but does NOT prove the cap actually got registered.
 *   `getBindings` is the runtime source of truth — every entry there
 *   is a live (`registerNativeCap`-completed) provider on the kernel.
 *
 * Result semantics (intentional):
 *   - feature has a cap mapping AND that cap IS in bindings →
 *     show as `native` (binding.kind === 'native') or `enhanced`
 *     (binding.kind === 'wrapped' — a wrapper addon enhances it).
 *   - feature has NO cap mapping → it's an informational marker
 *     (`battery-operated`, `doorbell-button`, etc.). Render but
 *     don't claim a binding state.
 *   - feature has a cap mapping but the cap is NOT in bindings →
 *     hide. The driver advertised but didn't register — broken
 *     state; honest answer is "not wired".
 *
 * While bindings are loading we return all raw features as markers
 * so the icon row renders without flickering on first paint.
 */
import { useEffect, useState } from 'react'
import type { DeviceBinding, DeviceBindingEntry } from '@camstack/types'
import { FEATURE_TO_CAP_NAME } from '../composites/device-item/helpers'
import type { UseDeviceProxyTrpc } from './use-device-proxy'

export type ResolvedFeatureKind = 'native' | 'enhanced' | 'marker'

export type ResolvedFeature =
  | { readonly kind: 'native'; readonly feature: string; readonly capName: string }
  | { readonly kind: 'enhanced'; readonly feature: string; readonly capName: string }
  | { readonly kind: 'marker'; readonly feature: string }

export interface UseDeviceFeaturesResult {
  /** Pending or unresolved (during initial bindings fetch). */
  readonly loading: boolean
  /**
   * Resolved list — features whose corresponding cap is in bindings,
   * PLUS pure markers (FEATURE_TO_CAP_NAME has no entry). Features
   * with a cap mapping that is NOT in bindings are filtered out.
   */
  readonly resolved: readonly ResolvedFeature[]
}

const EMPTY: readonly ResolvedFeature[] = Object.freeze([])

function bindingKindToFeatureKind(kind: DeviceBindingEntry['kind']): 'native' | 'enhanced' {
  return kind === 'native' ? 'native' : 'enhanced'
}

function asMarkers(features: readonly string[]): readonly ResolvedFeature[] {
  return features.map((feature) => ({ kind: 'marker', feature }) as const)
}

function buildResolved(
  rawFeatures: readonly string[],
  binding: DeviceBinding,
): readonly ResolvedFeature[] {
  const byCap = new Map<string, DeviceBindingEntry>()
  // Defensive guard: a malformed/legacy binding payload (no `entries`)
  // is treated as an empty entry list — every advertised feature with
  // a cap mapping then falls into the "advertised but cap not in
  // bindings → hide" branch and only pure markers survive.
  const entries = binding.entries ?? []
  for (const entry of entries) byCap.set(entry.capName, entry)

  const out: ResolvedFeature[] = []
  for (const feature of rawFeatures) {
    const capName = FEATURE_TO_CAP_NAME[feature]
    if (capName === undefined) {
      // Pure marker (no cap to interrogate).
      out.push({ kind: 'marker', feature })
      continue
    }
    const entry = byCap.get(capName)
    if (!entry) {
      // Advertised but cap not registered — broken state, hide.
      continue
    }
    out.push({ kind: bindingKindToFeatureKind(entry.kind), feature, capName })
  }
  return out
}

export function useDeviceFeatures(
  trpc: UseDeviceProxyTrpc,
  deviceId: number | null,
  rawFeatures: readonly string[],
): UseDeviceFeaturesResult {
  const [binding, setBinding] = useState<DeviceBinding | null>(null)
  const [errored, setErrored] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    if (deviceId === null) {
      setBinding(null)
      setErrored(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setErrored(false)

    const refresh = async (): Promise<void> => {
      try {
        const next = await trpc.deviceManager.getBindings.query({ deviceId })
        if (cancelled) return
        setBinding(next)
        setLoading(false)
      } catch {
        if (cancelled) return
        // Fall back to "show everything as marker" so the operator at
        // least sees the addon's declarations on transient tRPC errors.
        setErrored(true)
        setLoading(false)
      }
    }

    void refresh()

    const sub = trpc.live?.onEvent.subscribe(
      { category: 'capability.binding-changed' },
      {
        onData: (evt) => {
          const src = evt.data?.source
          if (!src) {
            void refresh()
            return
          }
          if (src.type === 'device' && src.id === deviceId) void refresh()
        },
      },
    )

    return () => {
      cancelled = true
      sub?.unsubscribe()
    }
  }, [trpc, deviceId])

  if (rawFeatures.length === 0) {
    return { loading, resolved: EMPTY }
  }
  if (loading || errored || !binding) {
    return { loading, resolved: asMarkers(rawFeatures) }
  }
  return { loading: false, resolved: buildResolved(rawFeatures, binding) }
}
