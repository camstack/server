/**
 * Synchronous ownership / native-cap resolvers for the device-manager provider.
 * Free functions over a `ProviderContext` (DI); these back
 * `CapabilityRegistry`'s native fallback.
 *
 * This file also held `resolveLinkedStatus`, the read-time cross-device link
 * overlay. Wiring was deleted on 2026-08-08 — 0 links across 302 devices, a
 * month after the tab shipped — so the overlay, its re-entrancy guard and its
 * per-call source-read memo went with it. A cross-device derivation now
 * produces a DEVICE, not a field on somebody else's cap.
 */
import { resolveRemoteNativeCapFromRegistry } from './device-bindings-store.js'
import type { ProviderContext } from './device-provider-context.js'

/**
 * Sync ownership lookup backing persistence fallbacks (e.g. remove()
 * when the owning worker is offline). Ownership is keyed by numeric
 * deviceId → owning addonId as recorded in the persisted meta. NOT
 * a native-cap lookup: an addon can own a device without registering
 * every possible cap natively (e.g. RtspCamera without snapshotUrl
 * doesn't register the snapshot cap). Use `resolveNativeCapOwnerSync`
 * for cap-resolution paths.
 */
export function resolveDeviceOwnerSync(pctx: ProviderContext, deviceId: number): string | null {
  return pctx.metaStore.idToAddonId.get(deviceId) ?? null
}

/**
 * Sync lookup for the addon that registered a native provider for
 * `(capName, deviceId)`. Backs `CapabilityRegistry`'s native fallback
 * so the hub only synthesizes a cross-process proxy when the cap is
 * actually published — never on speculative device ownership.
 *
 * Resolution order:
 *  1. Hub-local `capabilityRegistry` (in-process natives — fastest path).
 *  2. Push-fed `remoteNativeCaps` cache (`DeviceBindingsChanged` events
 *     from forked workers — accurate in steady state).
 *  3. Handshake-fed `HubNodeRegistry` via `listClusterNativeCaps()`
 *     (D3 re-handshake after device restore — covers the Moleculer
 *     transport window where push events were lost). This is the
 *     reliable replacement for the deleted `syncWorkerNativeCaps` pull.
 */
export function resolveNativeCapOwnerSync(
  pctx: ProviderContext,
  capName: string,
  deviceId: number,
): { addonId: string; nodeId: string } | null {
  const localAddonId = pctx.host.capabilityRegistry?.getNativeAddonId(capName, deviceId) ?? null
  if (localAddonId) {
    return { addonId: localAddonId, nodeId: pctx.host.ctx.kernel.localNodeId ?? 'hub' }
  }
  const remote = pctx.host.remoteNativeCaps.get(deviceId)?.get(capName) ?? null
  if (remote) return { addonId: remote.addonId, nodeId: remote.nodeId }
  // Fall through to the handshake-fed registry for cases where the push
  // event was lost (hub restart, crash-respawn, restartAddon).
  return resolveRemoteNativeCapFromRegistry(pctx.bindingsDeps, capName, deviceId)
}
