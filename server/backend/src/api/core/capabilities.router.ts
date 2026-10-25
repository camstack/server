/**
 * Capability admin router — fixed core API (not a capability).
 *
 * Lets admins inspect the capability registry and set system/device
 * overrides. Wraps `CapabilityRegistry` directly (kernel primitive).
 */
import { z } from 'zod'
import type { CapabilityRegistry } from '@camstack/system'
import type { ConfigService } from '../../core/config/config.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'
import {
  writeCollectionEnabledSet,
  singletonPreferenceKey,
  writeSingletonPreference,
  type PreferenceRegistry,
} from './capability-preference-writes.js'

/** What this router reads and switches on the kernel registry. */
export type CapabilitiesRouterRegistry = PreferenceRegistry &
  Pick<
    CapabilityRegistry,
    | 'clearSingletonNodeOverride'
    | 'setDeviceOverride'
    | 'clearDeviceOverride'
    | 'getDeviceOverrides'
  >

export function createCapabilitiesRouter(
  registry: CapabilitiesRouterRegistry | null,
  config: Pick<ConfigService, 'set'>,
) {
  return trpcRouter({
    listCapabilities: adminProcedure
      .input(z.void())
      .query(() => registry?.listCapabilities() ?? []),

    getCapability: adminProcedure.input(z.object({ name: z.string() })).query(({ input }) => {
      if (!registry) return null
      return (
        registry.listCapabilities().find((c: { name: string }) => c.name === input.name) ?? null
      )
    }),

    setActiveSingleton: adminProcedure
      .input(
        z.object({
          capability: z.string(),
          addonId: z.string(),
          nodeId: z.string().optional(),
        }),
      )
      .output(z.void())
      .mutation(async ({ input }) => {
        if (!registry) throw new Error('Capability registry unavailable')
        // Persist FIRST, under the key the boot restorer reads
        // (`capabilities.singleton.<cap>` / `capabilities.singletonNode.<cap>.<node>`),
        // then switch live: a write that fails changes nothing (D675 amendment).
        await writeSingletonPreference(config, registry, {
          capability: input.capability,
          addonId: input.addonId,
          ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        })
      }),

    clearSingletonNodeOverride: adminProcedure
      .input(z.object({ capability: z.string(), nodeId: z.string() }))
      .output(z.void())
      .mutation(async ({ input }) => {
        if (!registry) throw new Error('Capability registry unavailable')
        // Persist the cleared state as null FIRST so the boot restorer doesn't
        // re-apply a stale override; only a write that landed clears it live.
        await config.set(singletonPreferenceKey(input.capability, input.nodeId), null)
        registry.clearSingletonNodeOverride(input.capability, input.nodeId)
      }),

    /**
     * Set the enabled set of providers for a collection capability in
     * one shot. Providers already registered on the capability that are
     * NOT in `enabledAddonIds` get disabled; the ones in the list are
     * re-enabled. Other collections are untouched. Intended as the
     * save endpoint for a bulk multi-select UI.
     */
    setCollectionEnabledProviders: adminProcedure
      .input(
        z.object({
          capability: z.string(),
          enabledAddonIds: z.array(z.string()),
        }),
      )
      .output(z.void())
      .mutation(async ({ input }) => {
        if (!registry) throw new Error('Capability registry unavailable')
        // Persisted under `capabilities.collection.<cap>` BEFORE the live
        // switch. It used to switch live only, so the operator's pick
        // reverted at the next boot (D62's defect, D675 amendment).
        await writeCollectionEnabledSet(config, registry, input.capability, input.enabledAddonIds)
      }),

    setDeviceCapability: adminProcedure
      .input(z.object({ deviceId: z.string(), capability: z.string(), addonId: z.string() }))
      .output(z.void())
      .mutation(({ input }) => {
        if (!registry) throw new Error('Capability registry unavailable')
        registry.setDeviceOverride(input.deviceId, input.capability, input.addonId)
      }),

    clearDeviceCapability: adminProcedure
      .input(z.object({ deviceId: z.string(), capability: z.string() }))
      .output(z.void())
      .mutation(({ input }) => {
        if (!registry) throw new Error('Capability registry unavailable')
        registry.clearDeviceOverride(input.deviceId, input.capability)
      }),

    getDeviceCapabilities: adminProcedure
      .input(z.object({ deviceId: z.string() }))
      .output(z.record(z.string(), z.string()))
      .query(({ input }) => {
        if (!registry) return {}
        const overrides = registry.getDeviceOverrides(input.deviceId)
        const result: Record<string, string> = {}
        for (const [cap, addonId] of overrides) {
          result[cap] = addonId
        }
        return result
      }),

    /*
     * `setDeviceCollectionFilter` / `clearDeviceCollectionFilter` were REMOVED
     * here (D556). They wrote an in-memory per-device allow list that nothing
     * persisted, so an operator's pick survived until the next hub restart and
     * then silently reverted — a control that looks like it works, which is the
     * defect D62 exists for. Which sources a camera has is now asked of the ONE
     * authority that already owned a per-camera function switch:
     * `deviceManager.setWrapperActive`. The registry keeps only its projection,
     * written by `device-source-activation.ts` and by nothing else.
     */
  })
}
