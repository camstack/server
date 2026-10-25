/**
 * Live events router — fixed core API (not a capability).
 *
 * Higher-level live-subscription API consumed by the admin UI dashboard.
 * Wraps `EventBusService` with per-device permission enforcement.
 */
import { z } from 'zod'
import type { SystemEvent } from '@camstack/types'
import type { EventBusService } from '../../core/events/event-bus.service.js'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service.js'
import { trpcRouter, protectedProcedure, iterableSubscription } from '../trpc/trpc.middleware.js'
import { liveEventInShareScope } from '../trpc/share-view-access.js'
import { scopedEventVisibility } from '../trpc/principal-visibility.js'
import { isPublicEvent, publicRecent } from './public-event-filter.js'
import { shareViewGrantOf, userError } from '@camstack/types'

// The pushed wire shape is `SystemEvent` from @camstack/types — the exact
// type `EventBusService.subscribe` hands its handlers. It MUST be a type
// exported from @camstack/types (not a local interface): the AppRouter
// type expansion (`scripts/generate-api-types.ts`) prints subscription
// output types by name, and a router-local name is unresolvable from the
// generated `packages/types/src/generated/addon-api.ts`.

export function createLiveEventsRouter(eb: EventBusService, ar: AddonRegistryService) {
  return trpcRouter({
    recentSystemEvents: protectedProcedure
      .input(
        z
          .object({
            category: z.string().optional(),
            limit: z.number().optional(),
          })
          .optional(),
      )
      .query(({ input, ctx }) => {
        // SECURITY (F0.5): a device-restricted scoped token must not read the
        // whole deployment's event history. `scopedEventVisibility` returns null
        // for admins and broad category-view operators (no filtering), or a
        // per-event predicate that keeps only events for devices the caller may
        // view. (Share-view tokens cannot reach this method — not allowlisted.)
        // An owner-only category (D224) is not history anyone may read. Both
        // projections run BEFORE the limit (`publicRecent`).
        const keep = scopedEventVisibility(ctx.user, ctx.deviceScopeLookup)
        return publicRecent(
          eb,
          input?.category ? { category: input.category } : {},
          input?.limit ?? 50,
          keep,
        )
      }),

    onEvent: protectedProcedure
      .input(z.object({ category: z.string().optional() }))
      .subscription(({ input, ctx }) => {
        // Share-view principals get a device-filtered stream: only events
        // attributable to an in-scope device are pushed (fail closed —
        // unattributable events are dropped).
        const shareScope = shareViewGrantOf(ctx.user.scopes ?? [])
        // Non-share scoped tokens get the SAME projection keyed to what they may
        // view (F0.5); admins and broad category-view operators are unfiltered.
        const scopedKeep = shareScope
          ? null
          : scopedEventVisibility(ctx.user, ctx.deviceScopeLookup)
        return iterableSubscription<SystemEvent>((push) => {
          const filter: Record<string, unknown> = {}
          if (input.category) filter.category = input.category
          // Every branch refuses an owner-only category first (D224): a
          // subscriber that names no category gets every PUBLIC one.
          if (shareScope) {
            const allowedDeviceIds: ReadonlySet<number> = new Set(shareScope.deviceIds)
            return eb.subscribe(filter, (evt) => {
              if (isPublicEvent(evt) && liveEventInShareScope(evt, allowedDeviceIds)) push(evt)
            })
          }
          if (scopedKeep) {
            return eb.subscribe(filter, (evt) => {
              if (isPublicEvent(evt) && scopedKeep(evt)) push(evt)
            })
          }
          return eb.subscribe(filter, (evt) => {
            if (isPublicEvent(evt)) push(evt)
          })
        })
      }),

    onDeviceEvent: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .subscription(({ input, ctx }) => {
        return iterableSubscription<unknown>((push) => {
          const deviceRegistry = ar.getDeviceRegistry()
          const device = deviceRegistry.getById(input.deviceId)
          if (!device)
            throw userError(
              'device.not-found',
              { id: input.deviceId },
              `Device id=${input.deviceId} not found`,
            )
          // Permission check — new IDevice has no providerId; admin bypass only
          if (!ctx.user.isAdmin) {
            const ad = ctx.user.permissions?.allowedDevices
            if (!ad) throw userError('auth.access-denied', undefined, 'Access denied')
            // Find which addon owns this device to determine the provider key
            const ownerAddonId = deviceRegistry.getAddonId(input.deviceId)
            if (!ownerAddonId) throw userError('auth.access-denied', undefined, 'Access denied')
            const pd = ad[ownerAddonId]
            // Permission lists are still keyed by stableId — that's the
            // external admin-facing identifier. Resolve the device's
            // stableId for the membership check.
            if (!pd || (pd !== '*' && !pd.includes(device.stableId))) {
              throw userError('auth.access-denied', undefined, 'Access denied')
            }
          }
          return eb.subscribe({ source: { type: 'device', id: input.deviceId } }, (evt) => {
            if (isPublicEvent(evt)) push(evt)
          })
        })
      }),
  })
}
