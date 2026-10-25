/**
 * System events router — fixed core API (not a capability).
 *
 * Exposes recent-events query and live subscribe over the `EventBusService`.
 * Supports hierarchical filtering via EventFilter: agentId → addonId → deviceId.
 * All filters are applied server-side by the SystemEventBus — the client
 * only receives matching events.
 */
import { z } from 'zod'
import type { SystemEvent } from '@camstack/types'
import type { EventBusService } from '../../core/events/event-bus.service.js'
import { trpcRouter, protectedProcedure, iterableSubscription } from '../trpc/trpc.middleware.js'
import { scopedEventVisibility } from '../trpc/principal-visibility.js'
import { isPublicEvent, publicRecent } from './public-event-filter.js'

type SerializedEvent = {
  id: string
  timestamp: string
  source: {
    type: string
    id: string | number
    nodeId?: string
    addonId?: string
    deviceId?: number
  }
  category: string
  data: unknown
}

function serialize(e: SystemEvent): SerializedEvent {
  return {
    id: e.id,
    timestamp: new Date(e.timestamp).toISOString(),
    source: {
      type: e.source.type,
      id: e.source.id,
      ...(e.source.nodeId ? { nodeId: e.source.nodeId } : {}),
      ...(e.source.addonId ? { addonId: e.source.addonId } : {}),
      ...(e.source.deviceId !== undefined ? { deviceId: e.source.deviceId } : {}),
    },
    category: e.category,
    data: e.data,
  }
}

/**
 * Source / agent / addon / device fields shared by query + subscribe.
 * Category handling is split (asymmetric): see the per-method schemas
 * below.
 */
const ScopeFieldsSchema = z.object({
  /** Legacy source filter (exact type+id match). */
  source: z
    .object({
      type: z.string(),
      id: z.union([z.string(), z.number()]),
    })
    .optional(),
  /** Agent/node filter (prefix match: 'hub' matches 'hub/pipeline'). */
  agentId: z.string().optional(),
  /** Addon filter. Matches source.addonId or source.id when type='addon'. */
  addonId: z.string().optional(),
  /** Device filter. Matches source.deviceId or source.id when type='device'. */
  deviceId: z.number().optional(),
})

/**
 * `getRecent` accepts a category array so the UI can drive a
 * server-side whitelist when reading the historical buffer. Without
 * this, getRecent returns the last `limit` events of any category and
 * a noisy category (per-frame metrics) can displace relevant events
 * (provider.motion, detection.result) out of the window — which was
 * the symptom of "no events visible after page refresh".
 *
 * The underlying ring-buffer filter
 * (`addon-context-factory.ts:getRecent`) already iterates the
 * `category` field as `string | string[]`.
 */
const GetRecentInputSchema = ScopeFieldsSchema.extend({
  category: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

/**
 * `subscribe` keeps category as a single string — a WIRE choice now, not a bus
 * limitation.
 *
 * It used to be a limitation, and a silent one: the bus keyed handlers by
 * `extractCategoryPattern`, so an array filter routed only its FIRST category
 * and dropped the rest with no error. `extractCategoryPatterns` +
 * `registerSubscriber` (2026-08-12) register a subscriber under every category
 * it names, so an array here would now work. The single string stays because
 * one live SSE stream per category is what every consumer of this endpoint
 * actually opens; a UI that wants several can open several or subscribe by
 * wildcard and narrow client-side.
 */
const SubscribeInputSchema = ScopeFieldsSchema.extend({
  category: z.string().optional(),
})

export function createSystemEventsRouter(eb: EventBusService) {
  return trpcRouter({
    getRecent: protectedProcedure.input(GetRecentInputSchema).query(({ input, ctx }) => {
      // SECURITY (F0.5): filter the history to what a device-restricted scoped
      // token may view. null ⇒ admin / broad category-view operator ⇒ unfiltered.
      // An owner-only category (D224) is not history anyone may read. Both
      // projections run BEFORE the limit, so N asked is N public rows answered.
      const keep = scopedEventVisibility(ctx.user, ctx.deviceScopeLookup)
      return publicRecent(
        eb,
        {
          ...(input.source ? { source: input.source } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.addonId ? { addonId: input.addonId } : {}),
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          ...(input.category ? { category: input.category } : {}),
        },
        input.limit,
        keep,
      ).map(serialize)
    }),

    subscribe: protectedProcedure.input(SubscribeInputSchema).subscription(({ input, ctx }) => {
      // SECURITY (F0.5): a device-restricted scoped token must not receive every
      // camera's live events. Same projection as `getRecent`.
      const keep = scopedEventVisibility(ctx.user, ctx.deviceScopeLookup)
      return iterableSubscription<unknown>((push) => {
        return eb.subscribe(
          {
            ...(input.source ? { source: input.source } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(input.addonId ? { addonId: input.addonId } : {}),
            ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
            ...(input.category ? { category: input.category } : {}),
          },
          (event: SystemEvent) => {
            if (!isPublicEvent(event)) return
            if (!keep || keep(event)) push(serialize(event))
          },
        )
      })
    }),
  })
}
