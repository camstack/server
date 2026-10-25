/**
 * Events → Feed tab — the captured key-event feed.
 *
 * Every captured key event across all cameras: trajectory, media and clips.
 * Library owns the page chrome (`AdminPage`); this tab is body-only so it
 * does not stack a second gutter under the shell.
 */
import { useState } from 'react'
import { EventsSection } from '../components/detection-intelligence/EventsSection'
import { RetrainTabCallout } from '../components/detection-intelligence/RetrainTabCallout'
import { SemanticEventSearch } from '../components/detection-intelligence/SemanticEventSearch'
import { StationarySection } from '../components/detection-intelligence/StationarySection'

export function EventsFeedPage() {
  // NO `useEventsLiveRefresh()` here. `EventsSection` already calls it, and two
  // callers meant two independent coalescing windows invalidating the same
  // `['events-feed']` root — so a burst could refetch every camera's feed twice.
  // It also has to live there rather than here: the hook now takes a `paused`
  // flag, and only the section knows whether the operator is mid-read.

  // When a CLIP semantic search is active, the results REPLACE the normal feed
  // (one grid at a time); an empty query restores the feed unchanged.
  const [searchActive, setSearchActive] = useState(false)

  return (
    <section className="space-y-3">
      <RetrainTabCallout />
      <SemanticEventSearch onActiveChange={setSearchActive} />
      {!searchActive && <StationarySection />}
      {!searchActive && <EventsSection />}
    </section>
  )
}
