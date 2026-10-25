import type { Connection, UnsubscribeFunc } from 'home-assistant-js-websocket'
import { getCollection } from 'home-assistant-js-websocket'
import type { HaCompactUpdate, HaCompactStateDelta, HaEntityState } from './ha-types.js'

/**
 * Strongly-typed port of HA's compact-format reducer for the
 * (still-unmerged) `subscribe_entities` WebSocket surface. The HA
 * server emits per-tick diffs over its compact envelope; this reducer
 * folds them into a complete `Record<entityId, HaEntityState>` that
 * subscribers can consume directly.
 *
 * Source / parity reference: the same shape that lives in HA's own
 * `home-assistant-js-websocket` upstream PR
 * (https://github.com/home-assistant/home-assistant-js-websocket/issues/271).
 * Pure function — no I/O, easy to unit-test.
 *
 * Immutability: the function returns a NEW state map; previously-
 * referenced state objects are also replaced (Object.assign clones)
 * so downstream observers see fresh references on every applicable
 * delta — required for React-style equality checks to fire.
 */
export type HaEntityStateMap = Record<string, HaEntityState>

export function processEvent(
  current: HaEntityStateMap,
  updates: HaCompactUpdate,
): HaEntityStateMap {
  const next: HaEntityStateMap = { ...current }

  // Additions — new entities entering the subscription set.
  if (updates.a) {
    for (const entityId in updates.a) {
      const incoming = updates.a[entityId]!
      const lastChanged = new Date(incoming.lc * 1000).toISOString()
      const lastUpdated =
        incoming.lu !== undefined ? new Date(incoming.lu * 1000).toISOString() : lastChanged
      next[entityId] = {
        entity_id: entityId,
        state: incoming.s,
        attributes: incoming.a ?? {},
        context:
          typeof incoming.c === 'string'
            ? { id: incoming.c, parent_id: null, user_id: null }
            : incoming.c,
        last_changed: lastChanged,
        last_updated: lastUpdated,
      }
    }
  }

  // Removals — entities leaving the subscription set.
  if (updates.r) {
    for (const entityId of updates.r) {
      delete next[entityId]
    }
  }

  // Changes — partial deltas over existing entities.
  if (updates.c) {
    for (const entityId in updates.c) {
      const previous = next[entityId]
      if (!previous) continue
      const delta: HaCompactStateDelta = updates.c[entityId]!
      const toAdd = delta['+']
      const toRemove = delta['-']
      const attributesChanged = toAdd?.a !== undefined || toRemove?.a !== undefined
      const attributes = attributesChanged ? { ...previous.attributes } : previous.attributes

      let state = previous.state
      let context = previous.context
      let lastChanged = previous.last_changed
      let lastUpdated = previous.last_updated

      if (toAdd) {
        if (toAdd.s !== undefined) {
          state = toAdd.s
        }
        if (toAdd.c !== undefined) {
          context =
            typeof toAdd.c === 'string'
              ? { ...(context ?? { id: '', parent_id: null, user_id: null }), id: toAdd.c }
              : { ...(context ?? { id: '', parent_id: null, user_id: null }), ...toAdd.c }
        }
        if (toAdd.lc !== undefined) {
          lastChanged = new Date(toAdd.lc * 1000).toISOString()
          lastUpdated = lastChanged
        } else if (toAdd.lu !== undefined) {
          lastUpdated = new Date(toAdd.lu * 1000).toISOString()
        }
        if (toAdd.a !== undefined) {
          Object.assign(attributes, toAdd.a)
        }
      }
      if (toRemove?.a !== undefined) {
        for (const key of toRemove.a) {
          delete attributes[key]
        }
      }

      next[entityId] = {
        entity_id: entityId,
        state,
        attributes,
        context,
        last_changed: lastChanged,
        last_updated: lastUpdated,
      }
    }
  }

  return next
}

/**
 * Subscribe to a filtered entity set. Uses HA's `subscribe_entities`
 * compact-format push and folds incoming deltas via `processEvent`.
 *
 * The subscription is server-side filtered to `entityIds` — passing
 * 500 ids is no more expensive than passing 5; HA only streams the
 * ones the addon adopted.
 *
 * Returns an unsubscribe function — call it when the addon shuts
 * down or the adopted entity set changes (the addon then re-subscribes
 * with the new set).
 */
export interface SubscribeEntitiesOptions {
  readonly connection: Connection
  readonly entityIds: readonly string[]
  readonly onChange: (entities: HaEntityStateMap) => void | Promise<void>
}

interface CollectionStore {
  state: HaEntityStateMap
  setState(state: HaEntityStateMap, replace: boolean): void
}

export function subscribeEntities(opts: SubscribeEntitiesOptions): UnsubscribeFunc {
  const { connection, entityIds, onChange } = opts
  // The hass-js-ws `getCollection` API caches one Connection-keyed
  // store; the cache key must be unique per (entityIds set) — we
  // join sorted ids so the same adopted set re-uses the same store.
  const cacheKey = `_ent_${[...entityIds].toSorted().join(',')}`

  const collection = getCollection<HaEntityStateMap>(
    connection,
    cacheKey,
    undefined,
    (conn, store) =>
      conn.subscribeMessage<HaCompactUpdate>(
        (update) => {
          const wrappedStore = store as CollectionStore
          const folded = processEvent(wrappedStore.state ?? {}, update)
          wrappedStore.setState(folded, true)
        },
        {
          type: 'subscribe_entities',
          entity_ids: [...entityIds],
        },
      ),
  )

  return collection.subscribe((entities) => {
    void onChange(entities)
  })
}
