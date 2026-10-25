/**
 * EventBus proxy router — allows forked workers to emit events to, and
 * read the recent-events registry of, the hub's EventBus via tRPC.
 *
 * Workers call `trpc.eventBusProxy.emit.mutate(event)` from their
 * `context.eventBus.emit()` implementation. The hub-side router
 * deserializes the event and emits it on the real EventBus.
 *
 * `getRecent` exposes the hub's retained recent-events registry to forked
 * addon runners. Post the `retainRecent` change (f5a93332) ONLY the hub
 * main process keeps the `recent[]` buffer — a child runner's own
 * `ctx.eventBus.getRecent()` now returns `[]`. Addons that need event
 * HISTORY (e.g. advanced-notifier's `testRule`) must read it from the hub
 * over this proxy instead of their local, non-retaining bus. This router
 * is in `CORE_NAMESPACES` (`core-cap-bridge.ts`), so the call reaches the
 * hub's `services.eventBus` from any hub-local child over the UDS/core-cap
 * path — exactly like `capabilities.*` / `system.*`.
 *
 * `subscribe` is routed through the existing `live.onEvent` subscription
 * and `systemEvents.subscribe` routers — no duplication needed here.
 *
 * Introduced in session 7 (EventBus wiring for forked addons).
 */

import type { IEventBus, SystemEvent } from '@camstack/types'
import { z } from 'zod'
import { adminProcedure, protectedProcedure, trpcRouter } from '../trpc/trpc.middleware.js'
import { scopedEventVisibility } from '../trpc/principal-visibility.js'
import { publicRecent } from './public-event-filter.js'

/**
 * Upper bound on the `getRecent` limit — kept in step with the hub's
 * `recent[]` ring-buffer size (`MAX_RECENT_EVENTS` in `event-bus-core.ts`).
 * Duplicated as a local literal rather than imported so this router does
 * not depend on the event-bus core internals.
 */
const MAX_RECENT_EVENTS = 1000

const SystemEventInputSchema = z.object({
  id: z.string(),
  timestamp: z.string(), // ISO 8601 — converted to Date on emit
  source: z.object({
    type: z.string(),
    id: z.string(),
  }),
  category: z.string(),
  data: z.record(z.string(), z.unknown()),
})

/**
 * `getRecent` input — mirrors `systemEvents.getRecent`'s category/limit
 * semantics. `category` accepts a single string or an array so a caller
 * can whitelist the categories it cares about server-side; `limit` is
 * capped at the hub's `recent[]` buffer size (`MAX_RECENT_EVENTS`).
 */
const GetRecentInputSchema = z.object({
  category: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.number().int().min(1).max(MAX_RECENT_EVENTS).optional(),
})

/**
 * Serialized recent event — `timestamp` is an ISO-8601 string so the
 * shape survives every transport (UDS/MsgPack, Moleculer) unchanged.
 * Callers reconstruct the `Date` on receipt. Mirrors the serialization
 * used by `systemEvents.getRecent`.
 */
const RecentEventOutputSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  source: z.object({
    type: z.string(),
    id: z.union([z.string(), z.number()]),
    nodeId: z.string().optional(),
    addonId: z.string().optional(),
    deviceId: z.number().optional(),
  }),
  category: z.string(),
  data: z.record(z.string(), z.unknown()),
})

type SerializedRecentEvent = z.infer<typeof RecentEventOutputSchema>

function serializeRecentEvent(e: SystemEvent): SerializedRecentEvent {
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

export function createEventBusProxyRouter(eventBus: IEventBus) {
  return trpcRouter({
    // ADMIN-ONLY. `emit` injects a fully-attributed SystemEvent onto the hub's
    // real EventBus — including a spoofable `source` (a fake `device`/`addon`
    // origin). Forked addons that legitimately emit reach this over the
    // trusted core-cap/UDS mesh, whose context is `createMeshTrpcContext`
    // (`isAdmin: true`), so gating it here withholds the surface from
    // non-admin HTTP/WS principals without blinding a worker.
    emit: adminProcedure
      .input(SystemEventInputSchema)
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ input }) => {
        eventBus.emit({
          id: input.id,
          timestamp: new Date(input.timestamp),
          source: { type: input.source.type, id: input.source.id },
          category: input.category,
          data: input.data,
        })
        return { ok: true as const }
      }),

    getRecent: protectedProcedure
      .input(GetRecentInputSchema)
      .output(z.array(RecentEventOutputSchema))
      .query(({ input, ctx }) => {
        // This router is on the PUBLIC app router too, not only the worker
        // bridge: the same two projections as `systemEvents.getRecent` apply —
        // owner-only categories are never served (D224) and a device-restricted
        // scoped token reads only its devices (F0.5). A worker reaches this over
        // the mesh context (`isAdmin: true`), so it skips only the SCOPE
        // projection — owner-only categories are stripped for every caller.
        const keep = scopedEventVisibility(ctx.user, ctx.deviceScopeLookup)
        return publicRecent(
          eventBus,
          input.category !== undefined ? { category: input.category } : undefined,
          input.limit,
          keep,
        ).map(serializeRecentEvent)
      }),
  })
}
