/**
 * Archive Review → the event tools that do not follow the timeline window:
 * semantic search over this camera, parked objects, the retrain shortcut and,
 * while the debug filter is on, the debug analysis of the marked tracks.
 * Collapsed by default so the review surface stays player + list + timeline.
 */
import { CollapsibleCard } from '@camstack/ui-library'
import { Search } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { RetrainTabCallout } from '../detection-intelligence/RetrainTabCallout'
import { SemanticEventSearch } from '../detection-intelligence/SemanticEventSearch'
import { StationarySection } from '../detection-intelligence/StationarySection'
import { EventsDebugPage } from '../../pages/EventsDebug'

export interface ReviewEventToolsProps {
  readonly deviceId: number
  /** The debug filter is on: show the debug analysis of the marked tracks. */
  readonly debug: boolean
}

export function ReviewEventTools({ deviceId, debug }: ReviewEventToolsProps): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <CollapsibleCard
      expanded={expanded || debug}
      onExpandedChange={setExpanded}
      header={
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Search className="h-3.5 w-3.5" />
          {t('archive.review.tools', 'Search, parked objects and debug')}
        </span>
      }
    >
      <div className="flex flex-col gap-3" data-testid="archive-review-tools">
        <RetrainTabCallout />
        <SemanticEventSearch deviceId={deviceId} />
        <StationarySection deviceId={deviceId} />
        {debug && <EventsDebugPage deviceId={deviceId} />}
      </div>
    </CollapsibleCard>
  )
}
