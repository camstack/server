/**
 * After a migration swap, flush every live copy of the TWO migrated numbers —
 * and nothing else.
 *
 * The requirement is real and inherited from the restart era: every in-memory
 * `id → addon` map and every live device instance holding one of these
 * numbers must be invalidated, and not by an event — telemetry may be dropped
 * (D8), and a dropped flush leaves a runner writing against the wrong camera.
 * What was NOT required was the blast radius: restarting the whole owning
 * addon took 28 devices down for one migrated camera (measured 2026-09-04),
 * and the same morning ~27 devices' native caps failed to come back after a
 * provider restart until the operator restarted both providers by hand,
 * twice. The restart was the flush of last resort pretending to be the
 * mechanism.
 *
 * What actually holds a migrated number, and how each copy is flushed:
 *
 *  1. **The owning runner's live `IDevice`** (id baked into the object, its
 *     native-cap registrations, its log tags) — `deviceProvider.reloadDevice`,
 *     an RPC into the owning addon that decommissions the one instance and
 *     re-creates it from the persisted rows (the same teardown/rehydrate pair
 *     graceful shutdown + boot restore already use). Children ride along:
 *     accessory children via `getAccessoryChildren()`, first-class children
 *     via the restore's pass 2 inside `reloadDevice`.
 *  2. **The hub's `idToAddonId` map** — patched here to the post-swap owners.
 *     `resolveDeviceOwnerSync` answers from this map alone; in the restart
 *     era it stayed stale until the provider re-registered.
 *  3. **The hub's push-fed `remoteNativeCaps` cache and hub-local native-cap
 *     registrations** for the two ids — dropped here; the runner's re-create
 *     pushes fresh registrations. (The handshake-fed `HubNodeRegistry`
 *     fallback can serve a stale entry until the next re-handshake — the
 *     same transient every worker-restart window has always had.)
 *
 * A runner that cannot reload (older deployed closure without the method, an
 * unreachable provider) falls back to the WHOLE-ADDON restart for that addon
 * only — reported with the same blast-radius line as before, because the
 * operator must still see `devicesTakenDown` when it happens.
 */
import type { ProviderContext } from './device-provider-context.js'

/** One migrated number and the identity that lives at it AFTER the swap. */
export interface MigratedDeviceTarget {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
}

export async function reloadMigratedDevices(
  pctx: ProviderContext,
  targets: readonly MigratedDeviceTarget[],
): Promise<void> {
  const ctx = pctx.host.ctx

  // Hub-side id-keyed caches first, for exactly these numbers. The map patch
  // makes `resolveDeviceOwnerSync` truthful immediately; the native-cap drops
  // clear entries that describe pre-swap hardware, and the reload below
  // re-pushes fresh ones.
  for (const target of targets) {
    pctx.metaStore.idToAddonId.set(target.deviceId, target.addonId)
    pctx.host.remoteNativeCaps.delete(target.deviceId)
    pctx.host.capabilityRegistry?.unregisterAllNativeForDevice(target.deviceId)
  }

  // Per-device reload at each owning runner, concurrent — independent addons.
  const fallbackAddons = new Map<string, number>()
  await Promise.all(
    targets.map(async (target) => {
      try {
        const provider = await pctx.host.requireDeviceProvider(target.addonId)
        const reloaded = await provider.reloadDevice({ stableId: target.stableId })
        ctx.logger.info('migration: device reloaded in place — no other device disturbed', {
          tags: { deviceId: target.deviceId },
          meta: {
            addonId: target.addonId,
            stableId: target.stableId,
            reloadedAs: reloaded.deviceId,
          },
        })
      } catch (err) {
        // Not silent, and not fatal: the narrow flush failed for THIS addon,
        // so the old mechanism — restart the whole owning addon — is the
        // fallback that still guarantees the maps are flushed.
        ctx.logger.error('migration: in-place reload FAILED — falling back to a provider restart', {
          tags: { deviceId: target.deviceId },
          meta: {
            addonId: target.addonId,
            stableId: target.stableId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        fallbackAddons.set(target.addonId, target.deviceId)
      }
    }),
  )
  if (fallbackAddons.size === 0) return

  await Promise.all(
    [...fallbackAddons.entries()].map(async ([addonId, migratedDeviceId]) => {
      // This restarts the whole ADDON, not the one device — every camera that
      // provider owns goes down together. Named because it is real: migrating
      // one camera between two providers took 23 of them offline at once on
      // 2026-09-04, and the operator read it as the broker having crashed.
      const owned = [...pctx.metaStore.idToAddonId.entries()].filter(
        ([, a]) => a === addonId,
      ).length
      ctx.logger.info('migration: restarting a whole provider to flush the id maps', {
        tags: { deviceId: migratedDeviceId },
        meta: { addonId, devicesTakenDown: owned },
      })
      await ctx.api.addons.restartAddon.mutate({ addonId })
    }),
  )
}
