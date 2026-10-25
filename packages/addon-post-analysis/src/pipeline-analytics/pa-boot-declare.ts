/**
 * The legacy collections pipeline-analytics declares at boot — the SAME list on
 * every node (hub and agent).
 *
 * Only the three tables that stay tables for good (records plan §3): `tracks`,
 * `media`, `object-events`. Every other analytics and notification-centre table
 * is a records kind, read and written through `ctx.records` on every node; a
 * legacy `declareCollection` for one of them recreated the empty shell the
 * operator drops offline. On an agent it recreated it on the HUB, because an
 * agent's settings store forwards there (D332) — the old "agents only" branch
 * was exactly that leak. There is no role parameter on purpose.
 */
import type { SettingsStoreClient } from '@camstack/types'
import { EventStore } from './store/event-store.js'
import { MediaStore } from './store/media-store.js'
import { TrackStore } from './store/track-store.js'

export async function declarePipelineAnalyticsBootCollections(
  store: SettingsStoreClient,
): Promise<void> {
  // Parallel: each declare is an independent idempotent ensureTable.
  await Promise.all([
    TrackStore.declare(store),
    MediaStore.declare(store),
    EventStore.declareObjectCollection(store),
  ])
}
